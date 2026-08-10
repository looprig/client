package storespec_test

import (
	"errors"
	"reflect"
	"testing"

	"github.com/looprig/client/internal/storespec"
)

func TestParse(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		raw     string
		want    storespec.Spec
		wantErr error // checked with errors.As against a zero-value target of this type
	}{
		{
			name: "fs scheme with absolute path",
			raw:  "fs:/tmp/x",
			want: storespec.Spec{Scheme: storespec.SchemeFS, Path: "/tmp/x", Raw: "fs:/tmp/x"},
		},
		{
			name: "fs scheme with relative path",
			raw:  "fs:./data",
			want: storespec.Spec{Scheme: storespec.SchemeFS, Path: "./data", Raw: "fs:./data"},
		},
		{
			name: "fs scheme with empty path",
			raw:  "fs:",
			want: storespec.Spec{Scheme: storespec.SchemeFS, Path: "", Raw: "fs:"},
		},
		{
			name: "nats scheme preserves the full URL in Raw",
			raw:  "nats://cloud:4222",
			want: storespec.Spec{Scheme: storespec.SchemeNATS, Raw: "nats://cloud:4222"},
		},
		{
			name:    "empty store spec",
			raw:     "",
			wantErr: &storespec.EmptyStoreError{},
		},
		{
			name:    "no scheme prefix at all",
			raw:     "just-a-path",
			wantErr: &storespec.InvalidStoreError{},
		},
		{
			name:    "unknown scheme",
			raw:     "s3:/bucket",
			wantErr: &storespec.UnknownSchemeError{},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := storespec.Parse(tt.raw)
			if tt.wantErr != nil {
				if err == nil {
					t.Fatalf("Parse(%q) error = nil, want %T", tt.raw, tt.wantErr)
				}
				// target is a fresh **ConcreteErrorType (reflect.New of the
				// dynamic *ConcreteErrorType stored in tt.wantErr), the shape
				// errors.As requires to check err's chain against a specific
				// concrete type rather than the bare error interface.
				target := reflect.New(reflect.TypeOf(tt.wantErr)).Interface()
				if !errors.As(err, target) {
					t.Fatalf("Parse(%q) error = %T(%v), want type %T", tt.raw, err, err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Parse(%q) unexpected error: %v", tt.raw, err)
			}
			if got != tt.want {
				t.Errorf("Parse(%q) = %+v, want %+v", tt.raw, got, tt.want)
			}
		})
	}
}
