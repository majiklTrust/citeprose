!#/bin/bash
(
  feed_id=${1:-1}
  echo curl -s -X POST http://localhost:3001/api/research/single   -H "Content-Type: application/json" -d '{"feedId": "'$feed_id'"}'
  curl -s -X POST http://localhost:3001/api/research/single   -H "Content-Type: application/json" -d '{"feedId": "'$feed_id'"}'|jq
)