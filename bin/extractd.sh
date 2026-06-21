!#/bin/bash


noyes() { read -p "$*? (y/N): " && if [[ ${REPLY,,} = y ]] || [[ ${REPLY,,} = yes ]]; then return 0; fi; return 1; }

v="${1}"
zip="/datavol/LinkedIn_Agent_drop/drop/LinkedIn_Agent-$v.zip"
# if noyes "extract $zip";then 
mkdir -p /datavol/$npm_package_name/drop/$v\
  && unzip -o "$zip" -d /datavol/$npm_package_name/drop/$v
# fi

# npm version $v && npm run build
