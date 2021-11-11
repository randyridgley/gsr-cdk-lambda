# Setup default AWS region
region=$(curl http://169.254.169.254/latest/meta-data/placement/region)
mkdir -p /home/ec2-user/.aws
cat > /home/ec2-user/.aws/config<<EOF
[default]
region = $region
EOF

# Setup bash env
export region=$region
export stackname=$1
export mskclusterarn=$(aws cloudformation describe-stacks --stack-name $stackname --region $region | jq --raw-output '.Stacks[0].Outputs[] | select(.OutputKey == "MSKClusterArn") | .OutputValue')
export zoo=$(aws kafka describe-cluster --cluster-arn $mskclusterarn --region $region | jq --raw-output '.ClusterInfo.ZookeeperConnectString')
export brokers=$(aws kafka get-bootstrap-brokers --cluster-arn $mskclusterarn --region $region | jq --raw-output '.BootstrapBrokerString')
export brokerstls=$(aws kafka get-bootstrap-brokers --cluster-arn $mskclusterarn --region $region | jq --raw-output '.BootstrapBrokerStringTls')
