#!/bin/bash
# PVE_LOCAL_UPDATE_SOURCE_V1
# Read only the two update settings; never execute .env as shell code.
pve_local_update_source() {
    local env_file="${1:-.env}" key line value
    for key in APP_UPDATE_REPOSITORY APP_UPDATE_BRANCH; do
        if [ -z "${!key:-}" ] && [ -f "$env_file" ]; then
            while IFS= read -r line || [ -n "$line" ]; do
                if [[ "$line" == "${key}="* ]]; then
                    value="${line#*=}"
                    value="${value%$'\r'}"
                    if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then value="${value:1:${#value}-2}"; fi
                    printf -v "$key" '%s' "$value"
                fi
            done < "$env_file"
        fi
    done
    APP_UPDATE_REPOSITORY="${APP_UPDATE_REPOSITORY:-insuusvenerati/ProxmoxVE-Local}"
    APP_UPDATE_BRANCH="${APP_UPDATE_BRANCH:-main}"
    if [[ ! "$APP_UPDATE_REPOSITORY" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$ || "$APP_UPDATE_REPOSITORY" == *.git ]]; then
        echo 'Invalid APP_UPDATE_REPOSITORY; use owner/repository' >&2; return 1
    fi
    if [[ ! "$APP_UPDATE_BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9_./-]*$ || "$APP_UPDATE_BRANCH" == *..* || "$APP_UPDATE_BRANCH" == *//* || "$APP_UPDATE_BRANCH" == */ ]]; then
        echo 'Invalid APP_UPDATE_BRANCH' >&2; return 1
    fi
    REPO_OWNER="${APP_UPDATE_REPOSITORY%/*}"
    REPO_NAME="${APP_UPDATE_REPOSITORY#*/}"
    export APP_UPDATE_REPOSITORY APP_UPDATE_BRANCH REPO_OWNER REPO_NAME
}
