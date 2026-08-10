module github.com/looprig/client

go 1.26.5

require (
	github.com/looprig/core v0.5.0
	github.com/looprig/fsstore v0.0.0
	github.com/looprig/harness v0.23.0
	github.com/looprig/natsstore v0.0.0
	github.com/looprig/storage v0.3.1
)

require (
	github.com/antithesishq/antithesis-sdk-go v0.7.2 // indirect
	github.com/google/go-tpm v0.9.8 // indirect
	github.com/klauspost/compress v1.19.1 // indirect
	github.com/looprig/inference v0.9.0 // indirect
	github.com/minio/highwayhash v1.0.4 // indirect
	github.com/nats-io/jwt/v2 v2.8.2 // indirect
	github.com/nats-io/nats-server/v2 v2.14.4 // indirect
	github.com/nats-io/nats.go v1.52.0 // indirect
	github.com/nats-io/nkeys v0.4.16 // indirect
	github.com/nats-io/nuid v1.0.1 // indirect
	golang.org/x/crypto v0.54.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/time v0.15.0 // indirect
)

// TODO(release): remove this replace and use the real published v0.23.0 once harness is pushed.
replace github.com/looprig/harness => /Users/ipotter/code/looprig/.worktrees/harness-main-baseline/.claude/worktrees/agent-a2cc1ee97950f2491

// TODO(release): remove this replace and use the real published v0.3.1 once storage is pushed.
replace github.com/looprig/storage => /Users/ipotter/code/looprig/storage

// TODO(release): remove this replace and use the real published version once fsstore is pushed.
replace github.com/looprig/fsstore => /Users/ipotter/code/looprig/fsstore

// TODO(release): remove this replace and use the real published version once natsstore is pushed.
replace github.com/looprig/natsstore => /Users/ipotter/code/looprig/natsstore
