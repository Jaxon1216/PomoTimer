package protocol

import (
	"bufio"
	"strings"
	"testing"
)

func TestReadRequestRejectsUnknownFields(t *testing.T) {
	reader := bufio.NewReader(strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"timer.getSnapshot","unexpected":true}` + "\n",
	))

	_, err := ReadRequest(reader)
	if err == nil {
		t.Fatal("expected request with unknown field to be rejected")
	}
}

func TestReadRequestAcceptsValidRequest(t *testing.T) {
	reader := bufio.NewReader(strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"timer.getSnapshot","params":{}}` + "\n",
	))

	request, err := ReadRequest(reader)
	if err != nil {
		t.Fatalf("ReadRequest returned error: %v", err)
	}
	if request.ID == nil || *request.ID != 1 {
		t.Fatalf("expected request ID 1, got %#v", request.ID)
	}
}
