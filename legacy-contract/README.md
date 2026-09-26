# legacy-contract

This directory retains only the Harness-era response fixtures needed by the
deprecated `wui.Handler` compatibility test. They are frozen legacy vectors,
not an active wire-contract authority, and new Harness routes or fixtures are
not added here.

Each file under `fixtures/` is legacy. This table is not prose: it is a fourth
list of the same fact, and `../legacy_contract_test.go` parses it and requires
it to agree with the route table, the digest table, and the directory listing.
The status column is here because it is part of the frozen wire shape and the
Go guard had no other record of it — `POST /v1/sessions` answering `200` instead
of `201` was previously caught only by the Node driver, which skips.

| Fixture | Deprecated route | Status |
| --- | --- | --- |
| `create_idle.json` | `POST /v1/sessions` | 201 |
| `gate_accepted.json` | `POST /v1/sessions/{sid}/gates/{gid}` | 202 |
| `input.json` | `POST /v1/sessions/{sid}/input` | 202 |
| `interrupt.json` | `POST /v1/sessions/{sid}/interrupt` | 202 |
| `restore.json` | `POST /v1/sessions/{sid}/restore` | 200 |
| `session_list.json` | `GET /v1/sessions` | 200 |

## Guard

`../legacy_contract_test.go` freezes these bytes with a recorded sha256 per file
and requires the directory listing, the deprecated route table, and the digest
table to be the same set. It uses only the standard library. That matters: the
only other reader is the cross-language driver in `../csrf_client_e2e_test.go`,
which skips whenever the Node toolchain or `node_modules` is absent — so before
this guard existed the vectors were unguarded in exactly the configuration
`make check` is required to support.

The active contract mirror lives in `../contract/` and is sourced byte-for-byte
from the pinned Core module's `sessionwire/v1` package.
