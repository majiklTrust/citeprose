#!/bin/bash

(
ver="${*}"
zip=/datavol/linkedin-ai-agent/drop/LinkedIn_Agent-$ver.zip
if [ -z "$1" ];then echo need version && exit 1;fi
if [ ! -r "$zip" ];then echo can\'t read LinkedIn_Agent-$ver.zip && exit 1;fi
touch "/datavol/linkedin-ai-agent/drop/LinkedIn_Agent-$ver.zip"

ls -l "/datavol/linkedin-ai-agent/drop/LinkedIn_Agent-$ver.zip"
)

