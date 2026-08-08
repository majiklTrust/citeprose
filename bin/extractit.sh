#!/bin/bash


noyes() { read -p "$*? (y/N): " && if [[ ${REPLY,,} = y ]] || [[ ${REPLY,,} = yes ]]; then return 0; fi; return 1; }

v="${1}"
if [ -n "$2" ];then echo "override $v with $2" && v="${2}";fi
zip="/datavol/LinkedIn_Agent_drop/drop/LinkedIn_Agent-$v.zip"
# if noyes "extract $zip";then
UNZIPPED=$(unzip -o "$zip" -d ..)\
  && mkdir -p /datavol/$npm_package_name/drop/$v\
  && unzip -o "$zip" -d /datavol/$npm_package_name/drop/$v\
  && npm version $v 2>/dev/null && npm run build 2>/dev/null\
  || exit 1

echo "\n$UNZIPPED"


### OLD NPM EXTRACT
# "unzip -o \"$(/bin/ls -tr /datavol/$npm_package_name/drop/*.zip|tail -1)\" -d .. || unzip -l /datavol/$npm_package_name/drop/\"$(/bin/ls -tr /datavol/$npm_package_name/drop/|tail -1)\" -d .."
###

    # unzip -o "$(/bin/ls -tr /datavol/$npm_package_name/drop/*.zip|tail -1)" -d .. \
    #   && v=$(basename $(/bin/ls -tr /datavol/$npm_package_name/drop/*.zip | tail -1))
    # v=${v##*-};v=${v%.zip}\
    #   && mkdir -p /datavol/$npm_package_name/drop/$v\
    #   && unzip -o "$(/bin/ls -tr /datavol/$npm_package_name/drop/*.zip|tail -1)" -d /datavol/$npm_package_name/drop/$v\
    #   && npm version $v && npm run build


    # "unzip -o \"$(/bin/ls -tr /datavol/$npm_package_name/drop/*.zip|tail -1)\" -d .. \
    #   && v=$(basename $(/bin/ls -tr /datavol/$npm_package_name/drop/*.zip | tail -1))
    # v=${v##*-};v=${v%.zip}\
    #   && mkdir -p /datavol/$npm_package_name/drop/$v\
    #   && unzip -o \"$(/bin/ls -tr /datavol/$npm_package_name/drop/*.zip|tail -1)\" -d /datavol/$npm_package_name/drop/$v\
    #   && npm version $v && npm run build; unzip -l \"$(/bin/ls -tr /datavol/$npm_package_name/drop/*.zip|tail -1)\"|$(which grep) 'scripts/testing' >/dev/null\
    #   && echo && echo found scripts/testing --\\> extracting to git \\\"Testing\\\" project",
