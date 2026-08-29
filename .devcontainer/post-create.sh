#!/usr/bin/env bash
# .devcontainer/post-create.sh
# Runs once, at container creation.
set -euo pipefail

echo "==> Installing extra tooling (no official feature exists for these)"

# kubectx / kubens
sudo curl -fsSL -o /usr/local/bin/kubectx \
  https://raw.githubusercontent.com/ahmetb/kubectx/v0.9.5/kubectx
sudo curl -fsSL -o /usr/local/bin/kubens \
  https://raw.githubusercontent.com/ahmetb/kubectx/v0.9.5/kubens
sudo chmod +x /usr/local/bin/kubectx /usr/local/bin/kubens

# k9s
K9S_VERSION="v0.32.7"
curl -fsSL "https://github.com/derailed/k9s/releases/download/${K9S_VERSION}/k9s_Linux_amd64.tar.gz" \
  | sudo tar -xz -C /usr/local/bin k9s

# stern (log tailing across pods)
STERN_VERSION="1.31.0"
curl -fsSL "https://github.com/stern/stern/releases/download/v${STERN_VERSION}/stern_${STERN_VERSION}_linux_amd64.tar.gz" \
  | sudo tar -xz -C /usr/local/bin stern

# kustomize
curl -fsSL "https://raw.githubusercontent.com/kubernetes-sigs/kustomize/master/hack/install_kustomize.sh" \
  | bash -s -- 5.5.0 /tmp
sudo mv /tmp/kustomize /usr/local/bin/kustomize

echo "==> Shell completions and aliases"
{
  echo 'source <(kubectl completion zsh)'
  echo 'source <(helm completion zsh)'
  echo 'alias k=kubectl'
  echo 'compdef k=kubectl'
} >> "$HOME/.zshrc"

echo "==> Versions"
kubectl version --client
helm version --short
terraform version | head -n1
k9s version --short || true

echo "==> Done"