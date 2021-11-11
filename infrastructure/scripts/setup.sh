#!/bin/bash
yum update -y
yum install python3.7 java-1.8.0-openjdk-devel nmap-ncat git jq maven -y
yum erase awscli -y
yum install amazon-linux-extras install docker -y
service docker start
usermod -a -G docker ec2-user


wget http://repos.fedorapeople.org/repos/dchen/apache-maven/epel-apache-maven.repo -O /etc/yum.repos.d/epel-apache-maven.repo
sed -i s/\$releasever/6/g /etc/yum.repos.d/epel-apache-maven.repo
yum install -y apache-maven

# unfortunately, it also comes with java version 7, so we need to install java 8 in order to be able to use it.
yum install java-1.8.0-openjdk-devel

# additionally, we must set the right version for usage. uninstalling java 7 is not good, b/c it also will uninstall the above installed maven..
update-alternatives --config java
update-alternatives --config javac

cd /home/ec2-user
wget https://bootstrap.pypa.io/get-pip.py
python3.7 get-pip.py --user
/home/ec2-user/.local/bin/pip3 install boto3 --user
/home/ec2-user/.local/bin/pip3 install awscli --user
/home/ec2-user/.local/bin/pip3 install kafka-python --user

# install AWS CLI 2 - access with aws2
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
./aws/install -b /usr/local/bin/aws2
ln -s /usr/local/bin/aws2/aws ~/.local/bin/aws2

# Create dirs, get Apache Kafka 2.7.0 and unpack it
mkdir -p kafka270 confluent

cd /home/ec2-user
ln -s /home/ec2-user/kafka270 /home/ec2-user/kafka
cd kafka270
wget http://archive.apache.org/dist/kafka/2.7.0/kafka_2.12-2.7.0.tgz
tar -xzf kafka_2.12-2.7.0.tgz --strip 1

# Get Confluent Community and unpack it
cd /home/ec2-user
cd confluent
wget http://packages.confluent.io/archive/5.4/confluent-community-5.4.1-2.12.tar.gz
tar -xzf confluent-community-5.4.1-2.12.tar.gz --strip 1

# Initialize the Kafka cert trust store
find /usr/lib/jvm/ -name "cacerts" -exec cp {} /tmp/kafka.client.truststore.jks \;

cd /home/ec2-user/environment/kafka
su -c "mkdir -p config" -s /bin/sh ec2-user
su -c "aws s3 cp s3://aws-streaming-artifacts/msk-lab-resources/producer.properties_msk /home/ec2-user/environment/kafka/config/" -s /bin/sh ec2-user
su -c "aws s3 cp s3://aws-streaming-artifacts/msk-lab-resources/consumer.properties /home/ec2-user/environment/kafka/config/" -s /bin/sh ec2-user
su -c "aws s3 cp s3://aws-streaming-artifacts/msk-lab-resources/schema-registry.properties /home/ec2-user/environment/kafka/config/" -s /bin/sh ec2-user

cd /home/ec2-user/environment/kafka
su -c "mkdir -p code" -s /bin/sh ec2-user
su -c "git -C /home/ec2-user/environment/kafka/code clone https://github.com/aws-samples/sasl-scram-secrets-manager-client-for-msk.git" -s /bin/sh ec2-user
su -c "cd /home/ec2-user/environment/kafka/code/sasl-scram-secrets-manager-client-for-msk/ && mvn clean install -f pom.xml && cp target/SaslScramSecretsManagerClient-1.0-SNAPSHOT.jar /home/ec2-user/environment/kafka/code" -s /bin/sh ec2-user
su -c "cd /home/ec2-user/environment/kafka/code/ && rm -rf sasl-scram-secrets-manager-client-for-msk" -s /bin/sh ec2-user

su -c "git -C /home/ec2-user/environment/kafka/code clone https://github.com/aws-samples/clickstream-producer-for-apache-kafka.git" -s /bin/sh ec2-user
su -c "cd /home/ec2-user/environment/kafka/code/clickstream-producer-for-apache-kafka/ && mvn clean package -f pom.xml && cp target/KafkaClickstreamClient-1.0-SNAPSHOT.jar /home/ec2-user/environment/kafka/code" -s /bin/sh ec2-user
su -c "cd /home/ec2-user/environment/kafka/code/ && rm -rf clickstream-producer-for-apache-kafka" -s /bin/sh ec2-user
