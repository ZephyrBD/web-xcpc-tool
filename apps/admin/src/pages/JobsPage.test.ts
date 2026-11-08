import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import * as elementPlus from 'element-plus'
import { useSessionStore } from '@/stores/session'
import type { BalloonTask, PrintTask } from '@/types'

const messageErrorMock = mock(() => ({}))
mock.module('element-plus', () => ({
  ...elementPlus,
  ElMessage: { ...elementPlus.ElMessage, error: messageErrorMock },
}))

const printPdfTaskMock = mock((_id: string, _apiFetch: unknown) => Promise.resolve())
mock.module('@/utils/printPdf', () => ({ printPdfTask: printPdfTaskMock }))

const printBalloonTaskMock = mock((_task: unknown, _apiFetch: unknown) => Promise.resolve())
mock.module('@/utils/printBalloon', () => ({ printBalloonTask: printBalloonTaskMock }))

const { default: JobsPage } = await import('./JobsPage.vue')

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let printTasks: PrintTask[] = []
let balloonTasks: BalloonTask[] = []
let ackShouldFail = false
const calls: Array<{ method: string; path: string; body: unknown }> = []

function mockFetch() {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const path = u.pathname.replace(/^\/wxt/, '')
    const method = init?.method ?? 'GET'
    let body: unknown = null
    if (typeof init?.body === 'string') body = JSON.parse(init.body)
    calls.push({ method, path, body })

    const printAck = path.match(/^\/admin\/api\/print-tasks\/(.+)\/ack$/)
    const balloonAck = path.match(/^\/admin\/api\/balloon-tasks\/(.+)\/ack$/)
    if (method === 'POST' && printAck) {
      if (ackShouldFail) {
        return new Response(JSON.stringify({ error: 'boom' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      }
      const t = printTasks.find((x) => x.id === printAck[1])
      if (t) t.status = (body as { status?: string })?.status === 'failed' ? 'failed' : 'printed'
      return new Response(JSON.stringify(t), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (method === 'POST' && balloonAck) {
      const t = balloonTasks.find((x) => x.id === balloonAck[1])
      if (t) t.status = 'delivered'
      return new Response(JSON.stringify(t), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (method === 'GET' && path === '/admin/api/print-tasks') {
      return new Response(JSON.stringify(printTasks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (method === 'GET' && path === '/admin/api/balloon-tasks') {
      return new Response(JSON.stringify(balloonTasks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }) as unknown as typeof fetch
}

function makePrintTask(id: string, overrides: Partial<PrintTask> = {}): PrintTask {
  return {
    id,
    location: `A-${id}`,
    teamName: `团队${id}`,
    teamId: `team-${id}`,
    originalFilename: `${id}.pdf`,
    status: 'pending',
    createdAt: '2026-11-07T10:00:00.000Z',
    ...overrides,
  }
}

function makeBalloonTask(id: string, overrides: Partial<BalloonTask> = {}): BalloonTask {
  return {
    id,
    contestId: 'c1',
    problemLabel: 'A',
    teamName: `气球队${id}`,
    location: `B-${id}`,
    status: 'pending',
    createdAt: '2026-11-07T10:00:00.000Z',
    ...overrides,
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  closed = false
  listeners: Record<string, Array<(e: { data: string }) => void>> = {}

  constructor(url: string | URL) {
    this.url = String(url)
    FakeEventSource.instances.push(this)
  }

  addEventListener(name: string, fn: (e: { data: string }) => void) {
    ;(this.listeners[name] ??= []).push(fn)
  }

  emit(name: string, data: unknown) {
    for (const fn of this.listeners[name] ?? []) fn({ data: JSON.stringify(data) })
  }

  close() {
    this.closed = true
  }
}

function mountPage() {
  const pinia = createPinia()
  const session = useSessionStore(pinia)
  session.sseToken = 'sse-tok-9'
  return mount(JobsPage, { global: { plugins: [pinia] } })
}

describe('JobsPage', () => {
  beforeEach(() => {
    localStorage.clear()
    messageErrorMock.mockClear()
    printPdfTaskMock.mockClear()
    printBalloonTaskMock.mockClear()
    ackShouldFail = false
    FakeEventSource.instances.length = 0
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
    printTasks = [makePrintTask('p1'), makePrintTask('p2', { status: 'printed' })]
    balloonTasks = [makeBalloonTask('b1')]
    calls.length = 0
    mockFetch()
  })

  test('renders both tabs with rows from the mocked APIs', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()

    expect(wrapper.text()).toContain('A-p1')
    expect(wrapper.text()).toContain('p1.pdf')
    const printTable = wrapper.find('.el-table')
    expect(printTable.findAll('.pill--pending').length).toBe(1)
    expect(printTable.findAll('.pill--printed').length).toBe(1)

    const balloonTab = wrapper.findAll('.el-tabs__item').find((t) => t.text().includes('气球'))
    expect(balloonTab).toBeDefined()
    await balloonTab!.trigger('click')
    await flush()
    await flush()

    expect(wrapper.text()).toContain('气球队b1')
    expect(wrapper.text()).toContain('B-b1')
    expect(wrapper.findAll('.pill--delivered').length).toBe(0)
  })

  test('标记已打 posts the printed ack and refreshes', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()

    const btn = wrapper.findAll('button').find((b) => b.text() === '标记已打')!
    expect(btn).toBeDefined()
    await btn.trigger('click')
    await flush()
    await flush()

    const ackCall = calls.find((c) => c.method === 'POST' && c.path.endsWith('/p1/ack'))
    expect(ackCall).toBeDefined()
    expect(ackCall!.body).toEqual({ status: 'printed' })
    expect(wrapper.findAll('.pill--printed').length).toBe(2)
  })

  test('标记失败 posts the failed ack body', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()

    const btn = wrapper.findAll('button').find((b) => b.text() === '标记失败')!
    expect(btn).toBeDefined()
    await btn.trigger('click')
    await flush()
    await flush()

    const ackCall = calls.find((c) => c.method === 'POST' && c.path.endsWith('/p1/ack'))
    expect(ackCall).toBeDefined()
    expect(ackCall!.body).toEqual({ status: 'failed' })
    expect(wrapper.findAll('.pill--failed').length).toBe(1)
  })

  test('气球任务 标记已送 posts to the balloon ack route', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()

    const balloonTab = wrapper.findAll('.el-tabs__item').find((t) => t.text().includes('气球'))!
    await balloonTab.trigger('click')
    await flush()
    await flush()

    const btn = wrapper.findAll('button').find((b) => b.text() === '标记已送')!
    expect(btn).toBeDefined()
    await btn.trigger('click')
    await flush()
    await flush()

    const ackCall = calls.find((c) => c.method === 'POST' && c.path.endsWith('/b1/ack'))
    expect(ackCall).toBeDefined()
    expect(wrapper.findAll('.pill--delivered').length).toBe(1)
  })

  test('a failed ack shows a friendly error and still refreshes', async () => {
    ackShouldFail = true
    const wrapper = mountPage()
    await flush()
    await flush()

    const btn = wrapper.findAll('button').find((b) => b.text() === '标记已打')!
    await btn.trigger('click')
    await flush()
    await flush()

    expect(messageErrorMock).toHaveBeenCalledWith('操作没成功，请再试一次')
    const lastCall = calls[calls.length - 1]
    expect(lastCall).toMatchObject({ method: 'GET' })
    expect(wrapper.text()).toContain('A-p1')
  })

  test('an SSE print-task event refreshes only the print list; balloon-task refreshes both-visible tab lists', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()
    const es = FakeEventSource.instances[0]
    expect(es.url).toContain('token=sse-tok-9')

    const getsBefore = calls.filter((c) => c.method === 'GET').length
    printTasks.push(makePrintTask('p3'))
    es.emit('print-task', makePrintTask('p3'))
    await wait(400)

    const getsAfter = calls.filter((c) => c.method === 'GET').length
    expect(getsAfter).toBe(getsBefore + 1)
    expect(wrapper.text()).toContain('A-p3')
  })

  test('打印 button fetches the pdf via the print util with the task id', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()

    const btn = wrapper.findAll('button').find((b) => b.text() === '打印')!
    expect(btn).toBeDefined()
    await btn.trigger('click')
    await flush()

    expect(printPdfTaskMock).toHaveBeenCalledWith('p1', expect.any(Function))
  })

  test('打印 button acks printed after the print util confirms (afterprint)', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()

    const btn = wrapper.findAll('button').find((b) => b.text() === '打印')!
    await btn.trigger('click')
    await flush()
    await flush()

    const ackCall = calls.find((c) => c.method === 'POST' && c.path.endsWith('/p1/ack'))
    expect(ackCall).toBeDefined()
    expect(ackCall!.body).toEqual({ status: 'printed' })
    expect(wrapper.findAll('.pill--printed').length).toBe(2)
  })

  test('气球任务 打印 button acks delivered after the print util confirms (afterprint)', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()

    const balloonTab = wrapper.findAll('.el-tabs__item').find((t) => t.text().includes('气球'))!
    await balloonTab.trigger('click')
    await flush()
    await flush()

    const balloonPane = wrapper.findAll('.el-tab-pane')[1]
    const btn = balloonPane!.findAll('button').find((b) => b.text() === '打印')!
    await btn.trigger('click')
    await flush()
    await flush()

    const ackCall = calls.find((c) => c.method === 'POST' && c.path.endsWith('/b1/ack'))
    expect(ackCall).toBeDefined()
    expect(wrapper.findAll('.pill--delivered').length).toBe(1)
  })

  test('auto-print ON: a new SSE print-task event triggers printPdfTask for the new id only', async () => {
    localStorage.setItem('cxtool_autoprint', '1')
    const wrapper = mountPage()
    await flush()
    await flush()
    const es = FakeEventSource.instances[0]

    es.emit('print-task', makePrintTask('p9'))
    await wait(400)

    const ids = printPdfTaskMock.mock.calls.map((c) => c[0])
    expect(ids).toContain('p9')
    expect(ids).not.toContain('p1')
    expect(ids).not.toContain('p2')
  })

  test('auto-print OFF: SSE print-task events do not trigger printPdfTask', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()
    const es = FakeEventSource.instances[0]

    es.emit('print-task', makePrintTask('p9'))
    await wait(400)

    expect(printPdfTaskMock).not.toHaveBeenCalled()
  })

  test('气球任务 打印 button calls printBalloonTask with the task', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()

    const balloonTab = wrapper.findAll('.el-tabs__item').find((t) => t.text().includes('气球'))!
    await balloonTab.trigger('click')
    await flush()
    await flush()

    const balloonPane = wrapper.findAll('.el-tab-pane')[1]
    const btn = balloonPane!.findAll('button').find((b) => b.text() === '打印')!
    expect(btn).toBeDefined()
    await btn.trigger('click')
    await flush()

    expect(printBalloonTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'b1', problemLabel: 'A' }),
      expect.any(Function),
    )
  })

  test('auto balloon-print ON: a new SSE balloon-task event fires for the new id only', async () => {
    localStorage.setItem('cxtool_autoprint_balloon', '1')
    const wrapper = mountPage()
    await flush()
    await flush()
    const es = FakeEventSource.instances[0]

    es.emit('balloon-task', makeBalloonTask('b9'))
    await wait(400)

    const ids = printBalloonTaskMock.mock.calls.map((c) => (c[0] as BalloonTask).id)
    expect(ids).toContain('b9')
    expect(ids).not.toContain('b1')
  })

  test('auto balloon-print OFF: SSE balloon-task events do not trigger printing', async () => {
    const wrapper = mountPage()
    await flush()
    await flush()
    const es = FakeEventSource.instances[0]

    es.emit('balloon-task', makeBalloonTask('b9'))
    await wait(400)

    expect(printBalloonTaskMock).not.toHaveBeenCalled()
  })

  test('empty print list shows the friendly empty state with illustration', async () => {
    printTasks = []
    balloonTasks = []
    const wrapper = mountPage()
    await flush()
    await flush()

    expect(wrapper.text()).toContain('打印队列空空的')
    expect(wrapper.find('svg.empty-art').exists()).toBe(true)
  })

  test('print table paginates: 25 rows show 20 on page 1, rest on page 2', async () => {
    printTasks = Array.from({ length: 25 }, (_, i) => makePrintTask(`p${i + 1}`))
    const wrapper = mountPage()
    await flush()
    await flush()

    const printPane = wrapper.find('.el-tab-pane')
    expect(printPane.findAll('.el-table__row').length).toBe(20)
    const next = printPane.find('.el-pagination .btn-next')
    expect(next.exists()).toBe(true)
    await next.trigger('click')
    await flush()
    await flush()

    expect(printPane.findAll('.el-table__row').length).toBe(5)
    expect(wrapper.text()).toContain('A-p25')
  })

  test('balloon table paginates the same way', async () => {
    balloonTasks = Array.from({ length: 25 }, (_, i) => makeBalloonTask(`b${i + 1}`))
    const wrapper = mountPage()
    await flush()
    await flush()
    const balloonTab = wrapper.findAll('.el-tabs__item').find((t) => t.text().includes('气球'))!
    await balloonTab.trigger('click')
    await flush()
    await flush()

    const balloonPane = wrapper.findAll('.el-tab-pane')[1]!
    expect(balloonPane.findAll('.el-table__row').length).toBe(20)
    await balloonPane.find('.el-pagination .btn-next').trigger('click')
    await flush()
    await flush()
    expect(balloonPane.findAll('.el-table__row').length).toBe(5)
  })
})
