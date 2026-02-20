// Package executor runs one submission inside a Kubernetes Job and records what
// happened.
package executor

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/event"
	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/k8s"
	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/store"
	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/stream"
)

// Executor turns submission events into Kubernetes Jobs.
type Executor struct {
	client    kubernetes.Interface
	store     *store.Store
	stream    *stream.Publisher
	log       *slog.Logger
	namespace string
	limits    k8s.Limits
}

func New(
	client kubernetes.Interface,
	st *store.Store,
	publisher *stream.Publisher,
	log *slog.Logger,
	namespace string,
	limits k8s.Limits,
) *Executor {
	return &Executor{
		client:    client,
		store:     st,
		stream:    publisher,
		log:       log,
		namespace: namespace,
		limits:    limits,
	}
}

// Execute creates the Job, follows its output, and records the outcome.
func (e *Executor) Execute(ctx context.Context, sub event.SubmissionEvent) error {
	log := e.log.With("submissionId", sub.SubmissionID, "language", sub.Language)

	runtime, err := k8s.RuntimeFor(sub.Language)
	if err != nil {
		return e.finish(ctx, sub, store.Result{
			Status: store.StatusFailed,
			Output: err.Error(),
		})
	}

	jobName := k8s.JobName(sub.SubmissionID)
	if err := e.store.RecordJobCreated(ctx, sub.SubmissionID, jobName, e.namespace); err != nil {
		return err
	}

	// The Job is created first so the ConfigMap can name it as its owner; Kubernetes
	// then garbage-collects the ConfigMap when the Job is reaped, leaving no cleanup
	// path of ours to leak.
	job := k8s.BuildJob(e.namespace, sub, runtime, e.limits)
	created, err := e.client.BatchV1().Jobs(e.namespace).Create(ctx, job, metav1.CreateOptions{})
	if err != nil {
		if apierrors.IsAlreadyExists(err) {
			// A redelivered Kafka record. The deterministic Job name turned a duplicate
			// execution into a no-op.
			log.Info("job already exists, skipping duplicate delivery", "job", jobName)
			return nil
		}
		return e.finish(ctx, sub, store.Result{
			Status: store.StatusFailed,
			Output: fmt.Sprintf("could not create execution job: %v", err),
		})
	}

	cm := k8s.BuildConfigMap(e.namespace, sub, runtime)
	cm.OwnerReferences = []metav1.OwnerReference{{
		APIVersion: "batch/v1",
		Kind:       "Job",
		Name:       created.Name,
		UID:        created.UID,
		Controller: ptrBool(true),
	}}
	if _, err := e.client.CoreV1().ConfigMaps(e.namespace).Create(ctx, cm, metav1.CreateOptions{}); err != nil &&
		!apierrors.IsAlreadyExists(err) {
		_ = e.deleteJob(ctx, jobName)
		return e.finish(ctx, sub, store.Result{
			Status: store.StatusFailed,
			Output: fmt.Sprintf("could not stage submission code: %v", err),
		})
	}

	log.Info("execution job created", "job", jobName, "namespace", e.namespace)

	// The batcher is the consumer that the OnLine hook was added for in Phase D. It is
	// closed before the outcome is published so its final flush lands ahead of the
	// terminal status — a client must never see COMPLETED and then more output.
	batcher := e.stream.NewBatcher(ctx, sub.SessionID, sub.SubmissionID)
	defer batcher.Close()

	// Start following logs before waiting for the outcome. This ordering is the whole
	// reason a timed-out submission still has output: the deadline deletes the pod.
	output := &k8s.OutputBuffer{
		OnLine: func(line string) { batcher.Add(ctx, line) },
	}
	waitForLogs := k8s.StartFollowing(ctx, e.client, e.namespace, sub.SubmissionID, output,
		func(podName string) {
			if err := e.store.MarkRunning(ctx, sub.SubmissionID); err != nil {
				log.Error("could not mark running", "error", err)
			}
			e.stream.PublishStatus(ctx, sub.SessionID, sub.SubmissionID, string(store.StatusRunning), nil)
			log.Info("execution started", "pod", podName)
		},
	)

	status, exitCode, err := e.awaitOutcome(ctx, jobName)
	if err != nil {
		return e.finish(ctx, sub, store.Result{Status: store.StatusFailed, Output: err.Error()})
	}

	// Give the log follower a moment to drain what the pod emitted before it died,
	// rather than racing the terminal condition.
	drain, cancel := context.WithTimeout(ctx, 3*time.Second)
	go func() { defer cancel(); waitForLogs() }()
	<-drain.Done()

	log.Info("execution finished", "status", status, "outputBytes", len(output.String()))

	// Flush any buffered lines before announcing the terminal status, so the ordering
	// a client observes matches the ordering that actually happened.
	batcher.Close()

	return e.finish(ctx, sub, store.Result{
		Status:   status,
		Output:   output.String(),
		ExitCode: exitCode,
	})
}

// awaitOutcome watches the Job until it reaches a terminal condition.
//
// Watching rather than polling: the status change arrives as an event the moment the
// Job controller writes it, which is both promptly correct and the mechanism Phase E
// reuses to push live status to the browser.
func (e *Executor) awaitOutcome(ctx context.Context, jobName string) (store.Status, *int32, error) {
	watcher, err := e.client.BatchV1().Jobs(e.namespace).Watch(ctx, metav1.ListOptions{
		FieldSelector: "metadata.name=" + jobName,
	})
	if err != nil {
		return store.StatusFailed, nil, fmt.Errorf("watch job: %w", err)
	}
	defer watcher.Stop()

	// The Job may already be terminal before the watch was established.
	if current, err := e.client.BatchV1().Jobs(e.namespace).Get(ctx, jobName, metav1.GetOptions{}); err == nil {
		if status, done := classify(current); done {
			return status, e.exitCode(ctx, jobName), nil
		}
	}

	for {
		select {
		case <-ctx.Done():
			return store.StatusFailed, nil, ctx.Err()
		case ev, ok := <-watcher.ResultChan():
			if !ok {
				return store.StatusFailed, nil, errors.New("job watch closed before a terminal state")
			}
			job, ok := ev.Object.(*batchv1.Job)
			if !ok {
				continue
			}
			if status, done := classify(job); done {
				return status, e.exitCode(ctx, jobName), nil
			}
		}
	}
}

// classify maps a Job's conditions onto a submission status.
//
// `DeadlineExceeded` is the reason that distinguishes "ran too long and was killed by
// the platform" from "the program itself failed", and it is the entire point of the
// phase — it must not be collapsed into a generic failure.
func classify(job *batchv1.Job) (store.Status, bool) {
	for _, condition := range job.Status.Conditions {
		if condition.Status != corev1.ConditionTrue {
			continue
		}
		switch condition.Type {
		case batchv1.JobComplete:
			return store.StatusCompleted, true
		case batchv1.JobFailed:
			if condition.Reason == "DeadlineExceeded" {
				return store.StatusTimeout, true
			}
			return store.StatusFailed, true
		}
	}
	return store.StatusQueued, false
}

// exitCode reads the container's exit status, best effort — the pod is often already
// gone by the time a Job is terminal, which is expected rather than an error.
func (e *Executor) exitCode(ctx context.Context, jobName string) *int32 {
	pods, err := e.client.CoreV1().Pods(e.namespace).List(ctx, metav1.ListOptions{
		LabelSelector: "job-name=" + jobName,
	})
	if err != nil || len(pods.Items) == 0 {
		return nil
	}
	for i := range pods.Items {
		for _, cs := range pods.Items[i].Status.ContainerStatuses {
			if cs.State.Terminated != nil {
				code := cs.State.Terminated.ExitCode
				return &code
			}
		}
	}
	return nil
}

func (e *Executor) deleteJob(ctx context.Context, name string) error {
	policy := metav1.DeletePropagationBackground
	return e.client.BatchV1().Jobs(e.namespace).Delete(ctx, name, metav1.DeleteOptions{
		PropagationPolicy: &policy,
	})
}

func (e *Executor) finish(ctx context.Context, sub event.SubmissionEvent, result store.Result) error {
	// Persist the outcome even if the surrounding context was cancelled, so a shutdown
	// mid-execution does not strand a submission at RUNNING forever.
	persistCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()

	// Database first, stream second. The row is the record; the event is a notification
	// that the record changed, so a client told COMPLETED can always read back a
	// COMPLETED row rather than racing ahead of it.
	err := e.store.MarkFinished(persistCtx, sub.SubmissionID, result)

	e.stream.PublishStatus(
		persistCtx, sub.SessionID, sub.SubmissionID, string(result.Status), result.ExitCode,
	)

	return err
}

func ptrBool(b bool) *bool { return &b }
