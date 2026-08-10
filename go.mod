module github.com/looprig/client

go 1.26.5

require (
	github.com/looprig/harness v0.23.0
	github.com/looprig/storage v0.3.1
)

require (
	github.com/looprig/core v0.5.0 // indirect
	github.com/looprig/inference v0.9.0 // indirect
)

// TODO(release): remove this replace and use the real published v0.23.0 once harness is pushed.
replace github.com/looprig/harness => /Users/ipotter/code/looprig/.worktrees/harness-main-baseline/.claude/worktrees/agent-a2cc1ee97950f2491

// TODO(release): remove this replace and use the real published v0.3.1 once storage is pushed.
replace github.com/looprig/storage => /Users/ipotter/code/looprig/storage
