import { ElMessage, ElMessageBox } from 'element-plus'

/**
 * Element Plus 服务式 API 的统一出口（docs/frontend/03 §5.4 豁免层）。
 * 收敛到单独模块一是便于复用，二是让测试可以 mock 反馈行为而不必
 * mock 整个 element-plus 模块（bun 的模块级 mock 会破坏组件事件装配）。
 */
export function messageSuccess(message: string): void {
  ElMessage.success(message)
}

export function messageError(message: string): void {
  ElMessage.error(message)
}

export function messageInfo(message: string): void {
  ElMessage.info(message)
}

export function confirmDialog(
  message: string,
  title: string,
  options?: { confirmButtonText?: string; cancelButtonText?: string; type?: 'warning' | 'info' | 'success' | 'error' },
): Promise<unknown> {
  return ElMessageBox.confirm(message, title, options)
}

export function alertDialog(message: string, title: string, options?: { confirmButtonText?: string; center?: boolean }): Promise<unknown> {
  return ElMessageBox.alert(message, title, options)
}
