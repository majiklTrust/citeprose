#!/bin/bash

(
i=${1:-1}
curl -s http://localhost:3001/api/logs?limit=$i|jq
)

