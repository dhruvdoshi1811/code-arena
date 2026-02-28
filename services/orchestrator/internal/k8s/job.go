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

// RuntimeSpec maps a language to its execution image and entrypoint file.
type RuntimeSpec struct {
	Image    string
	Filename string
	Command  []string
}

// Runtimes maps a submission language to its execution image.
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
	// TTLSeconds lets Kubernetes reap the finished Job.
	TTLSeconds int32
}

// DefaultLimits are intentionally tight.
func DefaultLimits() Limits {
	return Limits{
		CPU:             "500m",
		Memory:          "256Mi",
		DeadlineSeconds: 10,
		TTLSeconds:      300,
	}
}

// JobName is derived from the submission id, never random.
func JobName(submissionID string) string {
	return "codearena-" + submissionID
}

// BuildConfigMap holds the submission's source.
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
			// No retries.
			BackoffLimit: ptr.To[int32](0),
			// The platform-enforced timeout.
			ActiveDeadlineSeconds:   ptr.To(limits.DeadlineSeconds),
			TTLSecondsAfterFinished: ptr.To(limits.TTLSeconds),
			Completions:             ptr.To[int32](1),
			Parallelism:             ptr.To[int32](1),
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					RestartPolicy: corev1.RestartPolicyNever,
					// Without this the default is 30 seconds.
					TerminationGracePeriodSeconds: ptr.To[int64](5),
					// The single most important line in this file.
					AutomountServiceAccountToken: ptr.To(false),
					// Pod-level context; the container repeats what matters so neither alone is load-bearing.
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
							// The root filesystem is read-only.
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
