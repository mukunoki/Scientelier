#!/bin/zsh
cd "${0:A:h}" || exit 1
npm start -- --force-renderer-accessibility
