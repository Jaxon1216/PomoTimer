package protocol

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	Version     = 1
	MaxLineSize = 64 * 1024
)

type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type Response struct {
	JSONRPC string    `json:"jsonrpc"`
	ID      int64     `json:"id"`
	Result  any       `json:"result,omitempty"`
	Error   *RPCError `json:"error,omitempty"`
}

type Notification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func ReadRequest(reader *bufio.Reader) (Request, error) {
	line, err := reader.ReadBytes('\n')
	if err != nil {
		if errors.Is(err, io.EOF) && len(line) == 0 {
			return Request{}, io.EOF
		}
		return Request{}, err
	}
	if len(line) > MaxLineSize {
		return Request{}, fmt.Errorf("protocol line exceeds %d bytes", MaxLineSize)
	}

	var request Request
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return Request{}, fmt.Errorf("decode request: %w", err)
	}
	if request.JSONRPC != "2.0" || request.Method == "" {
		return Request{}, errors.New("invalid JSON-RPC request")
	}
	return request, nil
}

func WriteMessage(writer io.Writer, message any) error {
	payload, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("marshal message: %w", err)
	}
	if len(payload)+1 > MaxLineSize {
		return fmt.Errorf("protocol line exceeds %d bytes", MaxLineSize)
	}
	if _, err := writer.Write(append(payload, '\n')); err != nil {
		return fmt.Errorf("write message: %w", err)
	}
	return nil
}
