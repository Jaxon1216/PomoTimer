package main

import (
	"bufio"
	"errors"
	"io"
	"os"

	"github.com/easton/pomodoro-timer/core/internal/protocol"
	"github.com/easton/pomodoro-timer/core/internal/service"
)

func main() {
	server := service.NewServer()
	defer func() {
		_ = server.Close()
	}()

	reader := bufio.NewReaderSize(os.Stdin, protocol.MaxLineSize+1)
	for {
		request, err := protocol.ReadRequest(reader)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			return
		}

		if request.ID == nil {
			continue
		}
		result, rpcError := server.Handle(request)
		response := protocol.Response{
			JSONRPC: "2.0",
			ID:      *request.ID,
			Result:  result,
			Error:   rpcError,
		}
		if err := protocol.WriteMessage(os.Stdout, response); err != nil {
			return
		}
	}
}
