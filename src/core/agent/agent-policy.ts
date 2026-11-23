export function isDocumentEditRequest(userMessage: string): boolean {
  return /(?:修改|替换|插入|写入|改写|重写|重新写|重新撰写|润色|优化|修正|纠错|翻译成|帮我改|直接改|删除|移除|(?:按|按照).{0,16}(?:风格|格式|结构).{0,12}(?:写|改|整理)|仿照.{0,16}(?:风格|格式).{0,12}(?:写|改|整理)|apply|edit|replace|insert|rewrite|polish|fix|correct|translate|delete|remove)/i
    .test(userMessage.trim());
}
