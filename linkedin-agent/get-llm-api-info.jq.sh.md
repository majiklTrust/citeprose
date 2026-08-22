```bash
# Selection (pulling data out / reshaping)

npm run getmodels --silent | jq '.data[].id'
npm run getmodels --silent | jq '.data[] | {id, display_name}'
npm run getmodels --silent | jq '.data[].capabilities.thinking.types'
npm run getmodels --silent | jq '.data[].capabilities | keys'
npm run getmodels --silent | jq '.data[] | {id, max_input_tokens, max_tokens}'
npm run getmodels --silent | jq -r '.data[] | [.id, .display_name, (.max_input_tokens|tostring)] | @tsv'
npm run getmodels --silent | jq '{has_more, first_id, last_id}'
npm run getmodels --silent | jq '.data[].capabilities.effort | keys - ["supported"]'

# Filtering (keeping only matching entries)

npm run getmodels --silent | jq '.data[] | select(.capabilities.citations.supported == true) | .id'
npm run getmodels --silent | jq '.data[] | select(.capabilities.effort.max.supported == true) | .id'
npm run getmodels --silent | jq '.data[] | select(.max_input_tokens > 500000) | {id, max_input_tokens}'
npm run getmodels --silent | jq '.data[] | select(.id | test("opus")) | .id'
npm run getmodels --silent | jq '.data[] | select(.capabilities.thinking.types.enabled.supported == false) | .id'
npm run getmodels --silent | jq '.data[] | select(.capabilities.batch.supported and .capabilities.code_execution.supported) | .id'
npm run getmodels --silent | jq '[.data[] | select(.capabilities.pdf_input.supported) | .id]'
npm run getmodels --silent | jq 'if .has_more then "more pages" else "last page" end'
npm run getmodels --silent | jq '[paths as $p | select(getpath($p) == false) | $p | join(".")]'
```
```bash
curl -s https://api.anthropic.com/v1/models \
  -H "x-api-key: $(cat $APIKEY)" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json"

```
```json
{
  "data": [
    {
      "type": "model",
      "id": "claude-opus-5",
      "display_name": "Claude Opus 5",
      "created_at": "2026-07-24T00:00:00Z",
      "max_input_tokens": 1000000,
      "max_tokens": 128000,
      "capabilities": {
        "batch": {
          "supported": true
        },
        "citations": {
          "supported": true
        },
        "code_execution": {
          "supported": true
        },
        "context_management": {
          "supported": true,
          "clear_tool_uses_20250919": {
            "supported": true
          },
          "clear_thinking_20251015": {
            "supported": true
          },
          "compact_20260112": {
            "supported": true
          }
        },
        "effort": {
          "supported": true,
          "low": {
            "supported": true
          },
          "medium": {
            "supported": true
          },
          "high": {
            "supported": true
          },
          "xhigh": {
            "supported": true
          },
          "max": {
            "supported": true
          }
        },
        "image_input": {
          "supported": true
        },
        "pdf_input": {
          "supported": true
        },
        "structured_outputs": {
          "supported": true
        },
        "thinking": {
          "supported": true,
          "types": {
            "enabled": {
              "supported": false
            },
            "adaptive": {
              "supported": true
            }
          }
        }
      }
    }
  ],
  "has_more": false,
  "first_id": "claude-opus-5",
  "last_id": "claude-sonnet-4-5-20250929"
}

```
```bash
export ANTHROPIC_API_KEY=$(cat $APIKEY)
curl -s https://api.anthropic.com/v1/models \
  -H "x-api-key: $(cat $APIKEY)" \
  -H "anthropic-version: 2023-06-01" \
| jq '.data[] | {
    id,
    name: .display_name,
    capabilities: (.capabilities | with_entries(select(.key != "effort" and .value.supported == true)))
}'
```
## Anthropic Models
```bash
for model in $(curl -s "https://api.anthropic.com/v1/models" \
-H "x-api-key: $ANTHROPIC_API_KEY" \
-H "anthropic-version: 2023-06-01"   | jq -r '.data[].id')
do echo $model
# curl -s https://api.anthropic.com/v1/models/$model \
# -H "x-api-key: $ANTHROPIC_API_KEY" \
# -H "anthropic-version: 2023-06-01" \
# | jq
done
```
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-sonnet-5",
    "max_tokens": 16,
    "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 1}],
    "messages": [{"role": "user", "content": "test"}]
  }'
```
## Web Search Tools
```bash
curl -s "https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/src/resources/messages/messages.ts" \
  | $(which grep) -o 'web_search_[0-9]\{8\}' | sort -u

# web_search_20250305
# web_search_20260209
# web_search_20260318
```
```bash

```
