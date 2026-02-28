package k8s

import (
	"testing"

	corev1 "k8s.io/api/core/v1"

	"github.com/dhruvdoshi1811/code-arena/services/orchestrator/internal/event"
)

// These tests are the durable form of the security argument.

func testSubmission() event.SubmissionEvent {
	return event.SubmissionEvent{
		SubmissionID: "11111111-2222-3333-4444-555555555555",
		SessionID:    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		UserID:       "99999999-8888-7777-6666-555555555555",
		Language:     event.LanguagePython,
		Code:         "print('hello')",
	}
}

func buildForTest(t *testing.T) (*corev1.PodSpec, *corev1.Container) {
	t.Helper()
	runtime, err := RuntimeFor(event.LanguagePython)
	if err != nil {
		t.Fatalf("RuntimeFor: %v", err)
	}
	job := BuildJob("codearena-exec", testSubmission(), runtime, DefaultLimits())
	spec := &job.Spec.Template.Spec
	if len(spec.Containers) != 1 {
		t.Fatalf("expected exactly 1 container, got %d", len(spec.Containers))
	}
	return spec, &spec.Containers[0]
}

// Without this, an infinite loop is killed at its deadline and then retried six more times.
func TestJobDoesNotRetry(t *testing.T) {
	runtime, _ := RuntimeFor(event.LanguagePython)
	job := BuildJob("codearena-exec", testSubmission(), runtime, DefaultLimits())

	if job.Spec.BackoffLimit == nil || *job.Spec.BackoffLimit != 0 {
		t.Errorf("BackoffLimit must be 0, got %v", job.Spec.BackoffLimit)
	}
	if job.Spec.Template.Spec.RestartPolicy != corev1.RestartPolicyNever {
		t.Errorf("RestartPolicy must be Never, got %q", job.Spec.Template.Spec.RestartPolicy)
	}
}

// The timeout that makes "killed at the deadline" a platform guarantee.
func TestJobHasExecutionDeadline(t *testing.T) {
	runtime, _ := RuntimeFor(event.LanguagePython)
	job := BuildJob("codearena-exec", testSubmission(), runtime, DefaultLimits())

	if job.Spec.ActiveDeadlineSeconds == nil {
		t.Fatal("ActiveDeadlineSeconds must be set — without it a submission can run forever")
	}
	if got := *job.Spec.ActiveDeadlineSeconds; got != 10 {
		t.Errorf("ActiveDeadlineSeconds = %d, want 10", got)
	}
}

// The deadline only means what it says if the grace period is short.
func TestTerminationGracePeriodIsShort(t *testing.T) {
	spec, _ := buildForTest(t)

	if spec.TerminationGracePeriodSeconds == nil {
		t.Fatal("TerminationGracePeriodSeconds must be set — the default of 30s triples a 10s deadline")
	}
	if got := *spec.TerminationGracePeriodSeconds; got > 10 {
		t.Errorf("TerminationGracePeriodSeconds = %d, want a small value; untrusted code gets no graceful shutdown", got)
	}
}

// The single most consequential setting: a mounted token would let the code being sandboxed.
func TestPodHasNoServiceAccountToken(t *testing.T) {
	spec, _ := buildForTest(t)

	if spec.AutomountServiceAccountToken == nil || *spec.AutomountServiceAccountToken {
		t.Error("AutomountServiceAccountToken must be explicitly false")
	}
}

func TestContainerHasResourceLimits(t *testing.T) {
	_, container := buildForTest(t)

	cpu, ok := container.Resources.Limits[corev1.ResourceCPU]
	if !ok || cpu.IsZero() {
		t.Error("a CPU limit is required")
	}
	memory, ok := container.Resources.Limits[corev1.ResourceMemory]
	if !ok || memory.IsZero() {
		t.Error("a memory limit is required — this is what turns a memory bomb into an OOM kill")
	}
	if _, ok := container.Resources.Requests[corev1.ResourceCPU]; !ok {
		t.Error("CPU request is required for the scheduler to bound placement")
	}
}

func TestContainerIsLockedDown(t *testing.T) {
	_, container := buildForTest(t)

	sc := container.SecurityContext
	if sc == nil {
		t.Fatal("container SecurityContext must be set")
	}
	if sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot {
		t.Error("RunAsNonRoot must be true")
	}
	if sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation {
		t.Error("AllowPrivilegeEscalation must be false")
	}
	if sc.ReadOnlyRootFilesystem == nil || !*sc.ReadOnlyRootFilesystem {
		t.Error("ReadOnlyRootFilesystem must be true")
	}
	if sc.Capabilities == nil || len(sc.Capabilities.Drop) == 0 || sc.Capabilities.Drop[0] != "ALL" {
		t.Error("all capabilities must be dropped")
	}
	if sc.SeccompProfile == nil || sc.SeccompProfile.Type != corev1.SeccompProfileTypeRuntimeDefault {
		t.Error("seccomp RuntimeDefault must be set")
	}
	if sc.RunAsUser == nil || *sc.RunAsUser == 0 {
		t.Error("RunAsUser must be a non-zero UID")
	}
}

// The code arrives on a read-only mount.
func TestCodeIsMountedReadOnly(t *testing.T) {
	_, container := buildForTest(t)

	var found bool
	for _, mount := range container.VolumeMounts {
		if mount.Name == codeVolumeName {
			found = true
			if !mount.ReadOnly {
				t.Error("the code mount must be read-only")
			}
			if mount.MountPath != workspaceMount {
				t.Errorf("code mounted at %q, want %q", mount.MountPath, workspaceMount)
			}
		}
	}
	if !found {
		t.Error("no code volume mount found")
	}
}

// A read-only root filesystem breaks anything that writes, so /tmp is provided.
func TestScratchSpaceIsBounded(t *testing.T) {
	spec, _ := buildForTest(t)

	for _, volume := range spec.Volumes {
		if volume.Name != tmpVolumeName {
			continue
		}
		if volume.EmptyDir == nil {
			t.Fatal("/tmp must be an emptyDir")
		}
		if volume.EmptyDir.SizeLimit == nil || volume.EmptyDir.SizeLimit.IsZero() {
			t.Error("the /tmp emptyDir must have a size limit")
		}
		return
	}
	t.Error("no /tmp volume found, but the root filesystem is read-only")
}

// Kafka is at-least-once.
func TestJobNameIsDerivedFromSubmission(t *testing.T) {
	sub := testSubmission()

	first := JobName(sub.SubmissionID)
	second := JobName(sub.SubmissionID)
	if first != second {
		t.Errorf("JobName is not deterministic: %q vs %q", first, second)
	}
	if JobName("other-id") == first {
		t.Error("different submissions must produce different Job names")
	}
	if len(first) > 63 {
		t.Errorf("Job name %q is %d chars, exceeding the 63-char DNS label limit", first, len(first))
	}
}

// Locally built and side-loaded images do not exist on Docker Hub.
func TestImageIsNotPulledFromRegistry(t *testing.T) {
	_, container := buildForTest(t)

	if container.ImagePullPolicy != corev1.PullIfNotPresent {
		t.Errorf("ImagePullPolicy = %q, want IfNotPresent", container.ImagePullPolicy)
	}
}

// The namespace NetworkPolicy selects on this label.
func TestPodCarriesTheExecutionLabel(t *testing.T) {
	runtime, _ := RuntimeFor(event.LanguagePython)
	job := BuildJob("codearena-exec", testSubmission(), runtime, DefaultLimits())

	if got := job.Spec.Template.Labels[LabelComponent]; got != componentExecution {
		t.Errorf("pod label %s = %q, want %q", LabelComponent, got, componentExecution)
	}
	if got := job.Spec.Template.Labels[LabelSubmission]; got != testSubmission().SubmissionID {
		t.Errorf("submission label = %q, want the submission id", got)
	}
}

func TestConfigMapCarriesTheCodeUnderTheRuntimeFilename(t *testing.T) {
	sub := testSubmission()
	runtime, _ := RuntimeFor(event.LanguagePython)

	cm := BuildConfigMap("codearena-exec", sub, runtime)
	if got := cm.Data[runtime.Filename]; got != sub.Code {
		t.Errorf("ConfigMap[%s] = %q, want the submission code", runtime.Filename, got)
	}
	if cm.Name != JobName(sub.SubmissionID) {
		t.Errorf("ConfigMap name %q should match the Job name for ownership", cm.Name)
	}
}

func TestUnknownLanguageIsRejected(t *testing.T) {
	if _, err := RuntimeFor(event.Language("brainfuck")); err == nil {
		t.Error("an unknown language must not resolve to an execution image")
	}
}
