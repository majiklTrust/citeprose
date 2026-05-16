(
  feed_id=${1:-ai-guardrails}
  echo curl -X POST http://localhost:3001/api/generate-preview   -H "Content-Type: application/json"   -d '{"topicId":"'$feed_id'"}'
  curl -X POST http://localhost:3001/api/generate-preview   -H "Content-Type: application/json"   -d '{"topicId":"'$feed_id'"}'|jq
)