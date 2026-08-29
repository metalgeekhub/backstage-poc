# first add our custom repo to your local helm repositories
helm repo add headlamp https://kubernetes-sigs.github.io/headlamp/

# now you should be able to install headlamp via helm
helm install my-headlamp headlamp/headlamp --namespace kube-system

kubectl -n kube-system port-forward --address 0.0.0.0 svc/my-headlamp 3000:80

kubectl -n kube-system create serviceaccount headlamp-admin

kubectl create clusterrolebinding headlamp-admin --serviceaccount=kube-system:headlamp-admin --clusterrole=cluster-admin

kubectl create token headlamp-admin -n kube-system