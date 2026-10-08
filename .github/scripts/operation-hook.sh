aws() {
  node "${INFRA_REPOSITORY_DIRECTORY:?}/scripts/aws-operation.mjs" "$@"
}
export -f aws
