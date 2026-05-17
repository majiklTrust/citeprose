# npm run endpoints |
# $(which grep) -E "^router" |
# # grep -Po '^router\.(get|post|put|patch|delete)\("([^"]+)"(?:,\s*(optionalAuth|requirePermission\("([^"]+)"\)))?,\s*async' |
# awk '
# BEGIN {
#   printf "%-10s %-31s %-27s %-10s\n", "METHOD", "PATH", "PERMISSION", "HANDLER"
#   printf "%-10s %-31s %-27s %-10s\n", "------", "----", "----------", "-------"
# }

# {
#   # METHOD
#   if ($0 ~ /router\.get/) method="GET"
#   else if ($0 ~ /router\.post/) method="POST"
#   else if ($0 ~ /router\.put/) method="PUT"
#   else if ($0 ~ /router\.patch/) method="PATCH"
#   else if ($0 ~ /router\.delete/) method="DELETE"

#   # PATH
#   p = match($0, /"[^"]+"/)
#   path = substr($0, p+1, RLENGTH-2)

#   # PERMISSION
#   if ($0 ~ /optionalAuth/) {
#     perm = "optionalAuth"
#   } else if ($0 ~ /requirePermission/) {
#     q = match($0, /requirePermission\("[^"]+"\)/)
#     perm = substr($0, q+19, RLENGTH-21)
#   } else {
#     perm = "-"
#   }

#   printf "%-10s %-31s %-27s %-10s\n", method, path, perm, "async"
# }
# '


npm run endpoints |
$(which grep) -E "^router" |
# grep -Po '^router\.(get|post|put|patch|delete)\("([^"]+)"(?:,\s*(optionalAuth|requirePermission\("([^"]+)"\)))?,\s*async' |
awk '
{
  # METHOD
  if ($0 ~ /router\.get/) method="GET"
  else if ($0 ~ /router\.post/) method="POST"
  else if ($0 ~ /router\.put/) method="PUT"
  else if ($0 ~ /router\.patch/) method="PATCH"
  else if ($0 ~ /router\.delete/) method="DELETE"

  # PATH
  p = match($0, /"[^"]+"/)
  path = substr($0, p+1, RLENGTH-2)

  # PERMISSION
  if ($0 ~ /optionalAuth/) {
    perm = "optionalAuth"
  } else if ($0 ~ /requirePermission/) {
    q = match($0, /requirePermission\("[^"]+"\)/)
    perm = substr($0, q+19, RLENGTH-21)
  } else {
    perm = "-"
  }

  # Store for sorting
  printf "%s\t%s\t%s\tasync\n", method, path, perm
}
' |
sort -k1,1 -k2,2 |
awk '
BEGIN {
  printf "%-10s %-31s %-27s %-10s\n", "METHOD", "PATH", "PERMISSION", "HANDLER"
  printf "%-10s %-31s %-27s %-10s\n", "------", "----", "----------", "-------"
}
{
  printf "%-10s %-31s %-27s %-10s\n", $1, $2, $3, $4
}
'
