#!/bin/bash

(
if [ -z "$1" ];then echo need version && exit 1;fi
touch /datavol/linkedin-ai-agent/drop/LinkedIn_Agent-$1.zip

echo touch /datavol/linkedin-ai-agent/drop/LinkedIn_Agent-$1.zip
)

