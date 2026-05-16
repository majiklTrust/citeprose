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
-x ".DS_Store"
-x "**/.git/*" "*/.git" -x ".git/*" -x -x "**.git*"
-x "*/data/*" -x "*/data" -x "data/*" -x "**/data*"
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
-x ".DS_Store"
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
-x "**/.DS_Store" -x ".DS_Store"
-x "*/.git/*" -x "*/.git" -x ".git/*" -x "**/*.git*"
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
  -x "**/node_modules/*" -x "**/dump/*" -x "**/drop/*" -x "**/online_drop/*" -x "**/awscliv2.zip"
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
