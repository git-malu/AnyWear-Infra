aws() {
  node "${INFRA_REPOSITORY_DIRECTORY:?}/scripts/aws-window.mjs" "$@"
}
export -f aws
