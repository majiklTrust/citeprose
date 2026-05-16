#!/bin/bash

(
ver="${*}"
if [ -z "$1" ];then echo need version && exit 1;fi
touch "/datavol/linkedin-ai-agent/drop/LinkedIn_Agent-$ver.zip"

ls -l "/datavol/linkedin-ai-agent/drop/LinkedIn_Agent-$ver.zip"
)

