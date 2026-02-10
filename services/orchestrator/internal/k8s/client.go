package k8s

import (
	"fmt"
	"os"
	"path/filepath"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// NewClientset connects to the cluster, in-cluster first.
//
// The order matters for Phase F: deployed on EKS this process runs as a pod with a
// ServiceAccount, and rest.InClusterConfig() picks that up with no configuration. The
// kubeconfig fallback is the local development path against kind. One binary, both
// environments, no build tags.
func NewClientset(kubeconfigPath string) (*kubernetes.Clientset, error) {
	config, err := rest.InClusterConfig()
	if err != nil {
		path := kubeconfigPath
		if path == "" {
			home, homeErr := os.UserHomeDir()
			if homeErr != nil {
				return nil, fmt.Errorf("no in-cluster config and no home directory: %w", homeErr)
			}
			path = filepath.Join(home, ".kube", "config")
		}

		config, err = clientcmd.BuildConfigFromFlags("", path)
		if err != nil {
			return nil, fmt.Errorf("no in-cluster config and kubeconfig %q unusable: %w", path, err)
		}
	}

	// The orchestrator creates a Job per submission and watches them; the client-go
	// defaults (5 QPS) would throttle a burst into a crawl.
	config.QPS = 50
	config.Burst = 100

	return kubernetes.NewForConfig(config)
}
