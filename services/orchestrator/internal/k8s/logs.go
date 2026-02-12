package k8s

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// maxOutputBytes caps what is retained per submission. Untrusted code can print in a
// loop; without a ceiling one submission could exhaust the orchestrator's memory and
// then the database column.
const maxOutputBytes = 64 * 1024

// OutputBuffer accumulates a pod's output as it is produced.
//
// Written by the log-follow goroutine and read by the executor when the Job reaches a
// terminal state, so every access is behind a mutex.
type OutputBuffer struct {
	mu       sync.Mutex
	buf      bytes.Buffer
	truncated bool
	// OnLine is invoked for each line as it arrives. Phase E hangs live streaming off
	// this hook; Phase D leaves it nil and only accumulates.
	OnLine func(string)
}

func (o *OutputBuffer) append(line string) {
	o.mu.Lock()
	if o.buf.Len()+len(line)+1 <= maxOutputBytes {
		o.buf.WriteString(line)
		o.buf.WriteByte('\n')
	} else if !o.truncated {
		o.truncated = true
		o.buf.WriteString("\n[output truncated]\n")
	}
	hook := o.OnLine
	o.mu.Unlock()

	if hook != nil {
		hook(line)
	}
}

// String returns what has been captured so far.
func (o *OutputBuffer) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.buf.String()
}

// WaitForPod blocks until the Job's pod exists and has left Pending, returning its name.
//
// A log stream cannot be opened against a container that has not started, so this is a
// prerequisite rather than an optimisation.
func WaitForPod(ctx context.Context, client kubernetes.Interface, namespace, submissionID string) (string, error) {
	selector := fmt.Sprintf("%s=%s", LabelSubmission, submissionID)

	watcher, err := client.CoreV1().Pods(namespace).Watch(ctx, metav1.ListOptions{
		LabelSelector: selector,
	})
	if err != nil {
		return "", fmt.Errorf("watch pods: %w", err)
	}
	defer watcher.Stop()

	// The pod may already have started before the watch was established, so check the
	// current state first rather than waiting for an event that has already happened.
	pods, err := client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: selector})
	if err == nil {
		for i := range pods.Items {
			if podHasStarted(&pods.Items[i]) {
				return pods.Items[i].Name, nil
			}
		}
	}

	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case ev, ok := <-watcher.ResultChan():
			if !ok {
				return "", fmt.Errorf("pod watch closed before the pod started")
			}
			pod, ok := ev.Object.(*corev1.Pod)
			if !ok {
				continue
			}
			if podHasStarted(pod) {
				return pod.Name, nil
			}
		}
	}
}

func podHasStarted(pod *corev1.Pod) bool {
	switch pod.Status.Phase {
	case corev1.PodRunning, corev1.PodSucceeded, corev1.PodFailed:
		return true
	default:
		return false
	}
}

// FollowLogs streams a pod's output into the buffer until the stream ends.
//
// This runs *during* execution, which is not a preference. When a Job exceeds its
// activeDeadlineSeconds the Job controller deletes the pod, and a deleted pod's logs go
// with it — so an orchestrator that waits for a terminal condition before reading logs
// records empty output for precisely the timeout case this phase exists to demonstrate.
// Following from the moment the pod starts means the output already exists by then.
func FollowLogs(ctx context.Context, client kubernetes.Interface, namespace, podName string, out *OutputBuffer) error {
	req := client.CoreV1().Pods(namespace).GetLogs(podName, &corev1.PodLogOptions{
		Follow: true,
		// stdout and stderr are interleaved as the user would see them in a terminal;
		// separating them would misrepresent the ordering of a program's output.
		Timestamps: false,
	})

	stream, err := req.Stream(ctx)
	if err != nil {
		return fmt.Errorf("open log stream: %w", err)
	}
	defer stream.Close()

	scanner := bufio.NewScanner(stream)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	for scanner.Scan() {
		out.append(scanner.Text())
	}

	if err := scanner.Err(); err != nil && ctx.Err() == nil && err != io.EOF {
		// The stream ending abruptly is normal when the pod is killed mid-write; what
		// was captured up to that point still stands.
		return fmt.Errorf("read log stream: %w", err)
	}
	return nil
}

// StartFollowing waits for the pod and then follows its logs in the background,
// returning a function that blocks until the follow goroutine has finished.
func StartFollowing(
	ctx context.Context,
	client kubernetes.Interface,
	namespace, submissionID string,
	out *OutputBuffer,
	onRunning func(podName string),
) (wait func()) {
	done := make(chan struct{})

	go func() {
		defer close(done)

		podName, err := WaitForPod(ctx, client, namespace, submissionID)
		if err != nil {
			return
		}
		if onRunning != nil {
			onRunning(podName)
		}

		// A short retry: the pod can report Running a beat before the container is
		// ready to serve logs.
		for attempt := 0; attempt < 3; attempt++ {
			if err := FollowLogs(ctx, client, namespace, podName, out); err == nil {
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(200 * time.Millisecond):
			}
		}
	}()

	return func() { <-done }
}
