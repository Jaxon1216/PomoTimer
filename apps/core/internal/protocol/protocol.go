package protocol

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// Version 是 Electron Main 与 Go Core 共同使用的 JSON-RPC 协议版本。
//
// 领域：Go / 协议版本
// 顺序：启动握手：Main core.initialize -> Go initialize 校验 Version -> 返回初始化结果。
// 作用：标识当前请求和响应模型的兼容性边界。
// 原因：两端独立构建时，必须在启动握手中拒绝不兼容的消息格式。
// 边界：版本不负责向后兼容；不匹配时由调用方终止启动。
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

// ReadRequest 从 stdin 的一行读取并严格解码一条 JSON-RPC 请求。
//
// 领域：Go / 协议分帧
// 顺序：请求接收链：Main stdin -> ReadRequest -> Server.Handle -> 状态机。
// 作用：限制单行大小、拒绝未知 JSON 字段，并检查 JSON-RPC 基本字段。
// 原因：字节流没有天然消息边界；严格解码能避免 Core 接受未定义的调用数据。
// 边界：此函数不验证某个 method 的业务参数，service 包按方法继续校验。
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

// WriteMessage 将一条 JSON-RPC 响应或通知编码为以换行结束的 JSON。
//
// 领域：Go / 协议分帧
// 顺序：响应返回链：状态机结果 -> WriteMessage -> stdout -> CoreSupervisor.handleResponse。
// 作用：把完整消息写入 stdout，并使用换行让 Electron Main 恢复消息边界。
// 原因：Main 按行累积 stdout；大小限制与 ReadRequest 一致以防止内存失控。
// 边界：只处理编码和写入，不判断 message 是成功结果、错误结果还是通知。
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
