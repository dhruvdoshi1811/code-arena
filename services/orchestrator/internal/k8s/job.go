// Package k8s builds and drives the Kubernetes objects that execute a submission.
package k8s

import (
	"fmt"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"

	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/event"
)

const (
	// LabelComponent marks execution pods so the namespace NetworkPolicy selects them.
	LabelComponent = "app.kubernetes.io/component"
	// LabelSubmission carries the submission id for correlation and log lookup.
	LabelSubmission = "codearena.dev/submission-id"

	componentExecution = "execution"
	workspaceMount     = "/workspace"
	codeVolumeName     = "code"
	tmpVolumeName      = "tmp"

	// Non-root UID baked into both execution images.
	runAsUID int64 = 65532
)

// RuntimeSpec is the per-language execution contract: which image runs a submission and
// what the mounted file must be called for that image's entrypoint to find it.
type RuntimeSpec struct {
	Image    string
	Filename string
	Command  []string
}

// Runtimes maps a submission language to its execution image. Two languages on purpose
// — the spec is explicit about not over-scoping this, and each one added is a new image
// to build, load, scan, and push.
var Runtimes = map[event.Language]RuntimeSpec{
	event.LanguagePython: {
		Image:    "codearena/exec-python:0.1.0",
		Filename: "main.py",
		Command:  []string{"python", workspaceMount + "/main.py"},
	},
	event.LanguageJavaScript: {
		Image:    "codearena/exec-javascript:0.1.0",
		Filename: "main.js",
		Command:  []string{"node", workspaceMount + "/main.js"},
	},
}

// Limits are the enforced execution bounds.
type Limits struct {
	CPU             string
	Memory          string
	DeadlineSeconds int64
	// TTLSeconds lets Kubernetes reap the finished Job. Safe only because logs are
	// followed live rather than read after the fact.
	TTLSeconds int32
}

// DefaultLimits are intentionally tight. Untrusted code has no legitimate reason to
// need more, and every one of these is enforced by the kubelet rather than by us.
func DefaultLimits() Limits {
	return Limits{
		CPU:             "500m",
		Memory:          "256Mi",
		DeadlineSeconds: 10,
		TTLSeconds:      300,
	}
}

// JobName is derived from the submission id, never random.
//
// Kafka delivers at least once. A redelivered record must not start a second execution,
// and a deterministic name turns that into an AlreadyExists error from the API server —
// the cheapest possible idempotency check, enforced by the thing that owns the objects.
func JobName(submissionID string) string {
	return "codearena-" + submissionID
}

// BuildConfigMap holds the submission's source. Mounted read-only; the code never
// arrives via an env var or a shell argument, so there is nothing to escape.
func BuildConfigMap(namespace string, sub event.SubmissionEvent, runtime RuntimeSpec) *corev1.ConfigMap {
	return &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      JobName(sub.SubmissionID),
			Namespace: namespace,
			Labels: map[string]string{
				LabelComponent:  componentExecution,
				LabelSubmission: sub.SubmissionID,
			},
		},
		Data: map[string]string{runtime.Filename: sub.Code},
	}
}

// BuildJob assembles the sandbox.
//
// Everything restrictive here is enforced by Kubernetes, not by the orchestrator. That
// distinction is the whole premise: an application that *asks* untrusted code to behave
// has no boundary at all, whereas the kubelet will kill a container that exceeds its
// memory limit and the Job controller will terminate one that outlives its deadline
// whether or not this process is even running.
func BuildJob(namespace string, sub event.SubmissionEvent, runtime RuntimeSpec, limits Limits) *batchv1.Job {
	name := JobName(sub.SubmissionID)

	labels := map[string]string{
		LabelComponent:  componentExecution,
		LabelSubmission: sub.SubmissionID,
	}

	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
			Labels:    labels,
		},
		Spec: batchv1.JobSpec{
			// No retries. Without this the default is 6, so an infinite loop would be
			// killed at its deadline and then handed six more deadlines to burn.
			BackoffLimit: ptr.To[int32](0),
			// The platform-enforced timeout. Note the consequence designed around
			// elsewhere: when this fires the pod is deleted, so logs must already have
			// been captured (see logs.go).
			ActiveDeadlineSeconds:   ptr.To(limits.DeadlineSeconds),
			TTLSecondsAfterFinished: ptr.To(limits.TTLSeconds),
			Completions:             ptr.To[int32](1),
			Parallelism:             ptr.To[int32](1),
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					RestartPolicy: corev1.RestartPolicyNever,
					// Without this the default is 30 seconds, and "killed at a 10s
					// deadline" silently becomes "killed at 40s".
					//
					// When the deadline fires the kubelet sends SIGTERM and waits out
					// this grace period before SIGKILL. The container's process is PID
					// 1, and PID 1 ignores any signal it has no explicit handler for —
					// so an interpreter running a tight loop never dies on SIGTERM and
					// always burns the full window. Untrusted code has not earned a
					// graceful shutdown; five seconds is enough for a well-behaved
					// program to flush and short enough that killed means killed.
					TerminationGracePeriodSeconds: ptr.To[int64](5),
					// The single most important line in this file. Left at its default,
					// the code being executed gets a ServiceAccount token mounted into
					// its filesystem and can talk to the API server that is supposed to
					// be sandboxing it.
					AutomountServiceAccountToken: ptr.To(false),
					// Pod-level context; the container repeats what matters so neither
					// alone is load-bearing.
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot:   ptr.To(true),
						RunAsUser:      ptr.To(runAsUID),
						RunAsGroup:     ptr.To(runAsUID),
						FSGroup:        ptr.To(runAsUID),
						SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
					},
					Containers: []corev1.Container{{
						Name:    "runner",
						Image:   runtime.Image,
						Command: runtime.Command,
						// The images are built locally and side-loaded into the node.
						// Always would send the kubelet to Docker Hub for a tag that
						// does not exist there.
						ImagePullPolicy: corev1.PullIfNotPresent,
						Resources: corev1.ResourceRequirements{
							Limits: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse(limits.CPU),
								corev1.ResourceMemory: resource.MustParse(limits.Memory),
							},
							Requests: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("100m"),
								corev1.ResourceMemory: resource.MustParse("64Mi"),
							},
						},
						SecurityContext: &corev1.SecurityContext{
							RunAsNonRoot:             ptr.To(true),
							RunAsUser:                ptr.To(runAsUID),
							AllowPrivilegeEscalation: ptr.To(false),
							ReadOnlyRootFilesystem:   ptr.To(true),
							Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
							SeccompProfile:           &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
						},
						VolumeMounts: []corev1.VolumeMount{
							{Name: codeVolumeName, MountPath: workspaceMount, ReadOnly: true},
							// The root filesystem is read-only, so anything that needs
							// to write gets this bounded scratch space and nothing else.
							{Name: tmpVolumeName, MountPath: "/tmp"},
						},
					}},
					Volumes: []corev1.Volume{
						{
							Name: codeVolumeName,
							VolumeSource: corev1.VolumeSource{
								ConfigMap: &corev1.ConfigMapVolumeSource{
									LocalObjectReference: corev1.LocalObjectReference{Name: name},
								},
							},
						},
						{
							Name: tmpVolumeName,
							VolumeSource: corev1.VolumeSource{
								EmptyDir: &corev1.EmptyDirVolumeSource{
									SizeLimit: ptr.To(resource.MustParse("16Mi")),
								},
							},
						},
					},
				},
			},
		},
	}
}

// RuntimeFor resolves a submission's language to its execution image.
func RuntimeFor(language event.Language) (RuntimeSpec, error) {
	runtime, ok := Runtimes[language]
	if !ok {
		return RuntimeSpec{}, fmt.Errorf("no execution image for language %q", language)
	}
	return runtime, nil
}
