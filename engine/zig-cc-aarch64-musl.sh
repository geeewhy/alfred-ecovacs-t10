#!/bin/sh
exec zig cc -target aarch64-linux-musl "$@" -nostdlib -nostartfiles
