#!/bin/bash
(
function usage { cat <<EOM                                                                                                                                                                                       
$(echo $(basename $0): ${FUNCNAME[0]})
    $*
EOM
}

function zip_deploy {
(
my_path=/datavol/LinkedIn_Agent_drop
PACKAGE=$my_path/backup/LinkedIn_Agent-$(date +%Y%m%dT%H%M%S)-deploy.zip
backup_path=~/LinkedIn_Agent_Deploy
ZIP_EXCLUDE=(
-x "**/.DS_Store" -x "**/*.dump" -x "**/*.log"
-x "**/.git/*" "*/.git" -x ".git/*" -x -x "**/*.git*"
-x "**/data/*" -x "*/data" -x "data/*" -x "**/data*"
-x "*/build/*" "*/build" -x "build/*" -x "**/build*"
-x "*.sh"
-x "*.log"
-x "*.zip" -x "*.tar.gz"
-x "Dockerfile"
)

pushd $backup_path
zip -9 -r -y $PACKAGE ./ "${ZIP_EXCLUDE[@]}" \
  -x "**/node_modules/*"
  # -x "**/package*.json"
sudo chmod 400 $PACKAGE
ls -lh $PACKAGE
unzip -l $PACKAGE|tail -1|awk '{print $2" "$3}'
popd
)
}

function zip_source {
(
my_path=/datavol/LinkedIn_Agent_drop
PACKAGE=$my_path/backup/LinkedIn_Agent-$(date +%Y%m%dT%H%M%S)-source.zip
backup_path=~/LinkedIn_Agent/src/LinkedIn_Agent
ZIP_EXCLUDE=(
-x "**/.DS_Store" -x "**/*.dump" -x "**/*.log"
-x "**/.env " -x ".env*"
-x "**/*nogit*"
-x "**/.git/*" "*/.git" -x ".git/*" -x "**/*.git*" -x "**.git*"
-x "*/data/*" -x "*/data" -x "data/*" -x "**/data*"
-x "*/build/*" "*/build" -x "build/*" -x "**/build*"
-x "*.sh"
-x "*.log"
-x "*.zip" -x "*.tar.gz"
-x "Dockerfile"
-x "*.code-workspace"
)

## Check zip contents w/o node_modules
pushd $backup_path
zip -9 -r -y $PACKAGE ./ "${ZIP_EXCLUDE[@]}" \
  -x "**/node_modules/*"
  # -x "**/package*.json"
sudo chmod 400 $PACKAGE
ls -lh $PACKAGE
unzip -l $PACKAGE|tail -1|awk '{print $2" "$3}'
popd
)
} ### END zip_source

function zip_all {
(
my_path=/datavol/LinkedIn_Agent_drop
PACKAGE=$my_path/backup/LinkedIn_Agent-$(date +%Y%m%dT%H%M%S)-all.zip
backup_path=~/LinkedIn_Agent
project=linkedin-agent
ZIP_EXCLUDE=(
-x "**/datavol/*" -x "**/datavol" -x "datavol/*" -x "**/datavol*" -x "**/*datavol*"
-x "**/.DS_Store" -x "**/*.dump" -x "**/*.log"
-x "**/.git/*" -x "*/.git" -x ".git/*" -x "**/*.git*"
-x "**/node_modules/*"
-x "**/dump" -x "**/dump/*" -x "dump/*" -x "dump"
-x "drop/*" -x "**/drop" -x "**/*drop*/*" -x "drop" -x "*drop*" -x "*source_link*"
-x "online_drop/*" -x "**/online_drop" -x "**/online_drop/*" -x "online_drop"
-x "awscliv2.zip"
)
for exclude in "$@";do
ZIP_EXCLUDE+=(-x "$exclude")
done

## Check zip contents w/o node_modules
pushd $backup_path
# echo zip -9 -r -y $PACKAGE ./ "${ZIP_EXCLUDE[@]}" \
#   -x "**/node_modules/*" -x "**/dump/*" -x "**/drop/*" -x "**/online_drop/*" -x "**/awscliv2.zip"
# read -p waiting x
zip -9 -r -y $PACKAGE ./ "${ZIP_EXCLUDE[@]}" \
  -x "**/node_modules/*" -x "**/dump/*" -x "**/drop/*" -x "**/online_drop/*" -x "**/awscliv2.zip" -x "**/*.dump" -x "**/*.log"
  # -x "**/package*.json"
zip -j $PACKAGE /datavol/LinkedIn_Agent_drop/bin/backup.sh
sudo chmod 400 $PACKAGE
ls -lh $PACKAGE
unzip -l $PACKAGE|tail -1|awk '{print $2" "$3}'
popd
)
} ### END zip_all

for i in "$@"
do
case $i in
--help|-h)
  shift
  usage "$(basename $BASH_SOURCE) <VERSION>"
  exit 0
  ;;
-a)
  shift
  zip_all $@
  exit 0
  ;;
-s)
  shift
  zip_source $@
  exit 0
  ;;
-d)
  shift
  zip_deploy $@

    cd /datavol && mkdir -p pgbackup && cd pgbackup
    # if ! command -v /usr/local/bin/aws;then
    #   curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /datavol/awscliv2.zip
    #   unzip -q -d /datavol/ /datavol/awscliv2.zip
    #   sudo /datavol/aws/install
    # fi
    # if [ ! -d ~/.aws ];then tar zxf operations-dotaws.tar.gz -C ~;fi
### AFTER ALL RUNS THEN DEFINE AND EXECUTE REMOTE DATABASE BACK & S3 PUT
    function SSHCMD { ssh -i $SSH_KEY_PATH $INSTANCE_USER@$SSH_PUBLIC_IP $* ; }
    function SCPCMD { scp -i $SSH_KEY_PATH $INSTANCE_USER@$SSH_PUBLIC_IP:$1 $2 ; }
    function do_pgbackup {
    (
      SSHCMD "export PGDATABASE=$PGDATABASE && export PGPORT=$PGPORT && export PGHOST=$PGHOST\
        && export PGUSER=$PGUSER && export PGPASSWORD=`echo P@ssw0rd\!`\
        && cd /home/ubuntu/marketing-ai/ && . ./do-backup.sh"
    )
    }
    function s3_put_pg_backup {
    local _5_MINUTES=`expr 60 \* 5`
    local _2_MINUTES=`expr 60 \* 2`
    local _30_SECONDS=30
    local _15_SECONDS=15
      export PGHOST=localhost
      export PGPORT=5432
      export PGUSER=***REMOVED***
      export PGDATABASE=***REMOVED***
    BAK=$(do_pgbackup)
    SCPCMD "/home/ubuntu/marketing-ai/db-backup-store/$BAK" "."
    pip install boto3
    url=$(python3 <<EOF
import boto3
s3 = boto3.client("s3")
url = s3.generate_presigned_url(
    ClientMethod="put_object",
    Params={"Bucket": "***REMOVED***", "Key": "pgsql/$BAK"},
    ExpiresIn=$_15_SECONDS
)
print(url)
EOF
    )
    echo $url
    curl -X PUT -T ./$BAK "$url"
    }

    # RUN THE BACKUP FROM
    backup_agent=developer
    deploy=/home/${backup_agent}/appdev/active/alpha.***REMOVED***/linkedin-agent/deploy
    INSTANCE_USER=ubuntu
    INSTANCE_ID=$(grep INSTANCE_ID ${deploy}/.deploy-state | tail -1 | cut -d= -f2)
    SSH_PUBLIC_IP=$(aws ec2 describe-instances --instance-ids $(grep INSTANCE_ID ${deploy}/.deploy-state | tail -1 | cut -d= -f2) --query 'Reservations[*].Instances[*].PublicIpAddress' --output text)
    KP=$(grep KEY_PATH ${deploy}/.deploy-state | tail -1 | cut -d= -f2)
    SSH_KEY_PATH=${deploy}/keys/$(basename $KP)
    s3_put_pg_backup


  exit 0
  ;;
esac
done

# my_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# echo "Script path: $my_path"
# echo "Script directory: $(basename $my_path)"
# echo "Script full path: $my_path/$(basename "${BASH_SOURCE[0]}")"

echo "Script full path: $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
zip_all $@

)
