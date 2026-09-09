package main

import (
	"bufio"
	"errors"
	"io"
	"os"

	"github.com/easton/pomodoro-timer/core/internal/protocol"
	"github.com/easton/pomodoro-timer/core/internal/service"
)

// 领域：Go / Sidecar 入口
// 顺序：命令和读快照链第 5 站：stdin -> ReadRequest -> Server.Handle -> WriteMessage -> stdout。
// 作用：持续从 stdin 读取 JSON-RPC 请求，交给 Server 处理后把响应写入 stdout。
// 原因：Electron Main 通过父子进程管道调用 Core，不开放 HTTP 端口或网络监听器。
// 边界：入口只负责协议循环和资源关闭；计时状态、校验和持久化由内部包处理。
func main() {
	server := service.NewServer()
	defer func() {
		_ = server.Close()
	}()

	reader := bufio.NewReaderSize(os.Stdin, protocol.MaxLineSize+1)
	for {
		// 领域：Go / 协议循环
		// 顺序：请求接收阶段：Main 写入 stdin -> ReadRequest -> Server.Handle。
		// 作用：读取一条有换行边界的请求，并在 EOF 时正常退出。
		// 原因：stdin 关闭表示 Electron 已停止 Core，不是需要写回错误响应的业务失败。
		// 边界：无效输入会停止本进程；输入格式校验由 protocol.ReadRequest 完成。
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
		// 领域：Go / JSON-RPC
		// 顺序：响应返回阶段：Server.Handle -> Response -> WriteMessage -> Main 的 stdout 监听器。
		// 作用：仅为带 ID 的请求生成响应。
		// 原因：JSON-RPC notification 没有 ID，协议规定接收方不得回复。
		// 边界：响应使用原始请求 ID；业务错误编码由 service 包决定。
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
