/**
 * 仪表盘卡片注册表：按 id 渲染对应卡片。
 * 各卡片的实现已拆分到 ./dashboard/*，这里只保留映射关系，方便单独调整某一张卡。
 */
import type { DashboardWidgetId } from '../../lib/dashboard';
import type { ProjectItem } from '../../lib/pm';
import type { TaskItem } from '../../lib/tasks';
import type { TestStatsItem } from '../../lib/test-stats';
import type { TodoItem } from '../../lib/todos';
import { ActiveTasksWidget } from './dashboard/ActiveTasksWidget';
import { CountdownWidget } from './dashboard/CountdownWidget';
import { ActiveProjectsCard } from './dashboard/kpi/ActiveProjectsCard';
import { OverdueCard } from './dashboard/kpi/OverdueCard';
import { SpacesCard } from './dashboard/kpi/SpacesCard';
import { TaskInProgressCard } from './dashboard/kpi/TaskInProgressCard';
import { TaskRateCard } from './dashboard/kpi/TaskRateCard';
import { TodoInProgressCard } from './dashboard/kpi/TodoInProgressCard';
import { TodoRateCard } from './dashboard/kpi/TodoRateCard';
import { TestChartWidget } from './dashboard/TestChartWidget';
import { TodayTodosWidget } from './dashboard/TodayTodosWidget';
import { TodoCalendarWidget } from './dashboard/TodoCalendarWidget';

export interface DashboardWidgetData {
  todos: TodoItem[];
  tasks: TaskItem[];
  stats: TestStatsItem[];
  /** 项目管理里的项目：活跃项目卡用 */
  projects: ProjectItem[];
  /** 空间总数 / 当前空间名；拿不到时为 null */
  spaces: { total: number; activeName: string } | null;
  todosOn: boolean;
  tasksOn: boolean;
  statsOn: boolean;
  projectsOn: boolean;
  errors: { todos?: string; tasks?: string; stats?: string; projects?: string };
  /** 勾选今日待办：交给 board 落库并刷新（状态在仪表盘里只读） */
  onToggleTodo: (item: TodoItem) => Promise<void>;
}

/** 按 id 渲染卡片内容；栅格跨度由 board 根据 DASHBOARD_WIDGETS 决定 */
export function DashboardWidgetBody({
  id,
  data,
}: {
  id: DashboardWidgetId;
  data: DashboardWidgetData;
}) {
  switch (id) {
    // 五个指标各是一张独立卡，不再套在「待办概览」里
    case 'todoInProgress':
      return <TodoInProgressCard todos={data.todos} enabled={data.todosOn} />;
    case 'taskInProgress':
      return <TaskInProgressCard tasks={data.tasks} enabled={data.tasksOn} />;
    case 'overdue':
      return <OverdueCard todos={data.todos} enabled={data.todosOn} />;
    case 'todoRate':
      return <TodoRateCard todos={data.todos} enabled={data.todosOn} />;
    case 'taskRate':
      return <TaskRateCard tasks={data.tasks} enabled={data.tasksOn} />;
    case 'activeProjects':
      return (
        <ActiveProjectsCard
          projects={data.projects}
          enabled={data.projectsOn}
          error={data.errors.projects}
        />
      );
    case 'spaces':
      return (
        <SpacesCard total={data.spaces?.total ?? null} activeName={data.spaces?.activeName ?? ''} />
      );
    case 'countdown':
      return <CountdownWidget />;
    case 'todayTodos':
      return (
        <TodayTodosWidget
          todos={data.todos}
          enabled={data.todosOn}
          error={data.errors.todos}
          onToggle={data.onToggleTodo}
        />
      );
    case 'activeTasks':
      return (
        <ActiveTasksWidget tasks={data.tasks} enabled={data.tasksOn} error={data.errors.tasks} />
      );
    case 'testChart':
      return (
        <TestChartWidget items={data.stats} enabled={data.statsOn} error={data.errors.stats} />
      );
    case 'todoCalendar':
      return (
        <TodoCalendarWidget todos={data.todos} enabled={data.todosOn} error={data.errors.todos} />
      );
  }
}
