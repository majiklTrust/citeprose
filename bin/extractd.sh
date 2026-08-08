#!/bin/bash


noyes() { read -p "$*? (y/N): " && if [[ ${REPLY,,} = y ]] || [[ ${REPLY,,} = yes ]]; then return 0; fi; return 1; }

v="${1}"
if [ -n "$2" ];then echo "override $v with $2" && v="${2}";fi
zip="/datavol/LinkedIn_Agent_drop/drop/LinkedIn_Agent-$v.zip"
mkdir -p /datavol/$npm_package_name/drop/$v\
  && unzip -o "$zip" -d /datavol/$npm_package_name/drop/$v
