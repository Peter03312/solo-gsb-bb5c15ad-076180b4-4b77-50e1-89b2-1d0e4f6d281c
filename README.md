# 事故复盘时间线（Retro Timeline）

供小组在本地协作的事故复盘时间线工具：记录事件的起始时间范围、持续分钟数与“先于”关系，
自动推算每个事件的可行时间窗并给出推算依据链。Python 标准库服务端 + SQLite 持久化 +
浏览器单页界面，无任何第三方依赖。

## 功能

- **事件建模**：每个事件包含起始时间范围（最早/最晚开始）、持续分钟数与备注。
- **“先于”约束**：A 先于 B 表示 A 必须在 B 开始前结束（A 开始 + A 持续 ≤ B 开始）。
- **时间窗推算**：前向/后向约束传播，给出每个事件的最早/最晚可行开始（即可行时间窗），
  并展示从输入到结论的完整依据链。
- **输入与结果分离保存**：原始输入存于 `events` / `relations` 表，每次保存的推算结果
  单独写入 `computations` 表（按复盘版本留存），互不覆盖。
- **冲突处理**：约束冲突（窗口不可满足、关系成环、输入范围自相矛盾）时保留全部输入，
  指出冲突事件及双方依据链，该版本**不得定稿**。
- **暂存事件**：缺少时间范围（或持续分钟数）的事件可暂存，其关联的“先于”关系
  暂不参与推算，并在页面上标明原因；存在暂存事件时同样不得定稿。
- **多人协作并发控制**：基于 `reviews.version` 的乐观锁。携带旧版本号的提交会被
  拒绝（HTTP 409）并提示刷新，不会覆盖他人较新的记录。
- **定稿**：推算通过且无暂存事件时可定稿；定稿后再次修改会自动回到草稿状态。

## 容器启动

```bash
# 方式一：Docker Compose（推荐）
docker compose up --build
# 或旧版：docker-compose up --build

# 方式二：纯 Docker
docker build -t retro-timeline .
docker run -d -p 8000:8000 -v retro-timeline-data:/data --name retro-timeline retro-timeline
```

容器启动时自动初始化数据库（创建目录与表结构），无需手动迁移。

## 网页访问

启动后浏览器访问：**http://localhost:8000**（默认端口，见下方 `PORT` 配置）。

## 可配置项

| 环境变量 | 默认值（容器内） | 说明 |
|---|---|---|
| `PORT` | `8000` | 服务监听端口。Compose 中同时用于宿主机映射：`PORT=9000 docker compose up` 后访问 `http://localhost:9000` |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `/data/timeline.db` | SQLite 数据库文件路径。容器内 `/data` 为挂载卷，删除容器数据不丢失 |

Compose 示例（`docker-compose.yml`）中已包含命名卷 `timeline-data` 用于持久化；
如改用宿主机目录，可将卷替换为 `./data:/data`。

## 本地开发（不用 Docker）

```bash
python3 app/server.py          # 默认监听 8000，数据库写入 ./data/timeline.db
PORT=9000 DB_PATH=/tmp/t.db python3 app/server.py
python3 tests/test_compute.py  # 推算引擎单元测试
```

## HTTP API 简介

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/reviews` | 复盘列表 |
| POST | `/api/reviews` | 新建复盘 `{title}` |
| GET | `/api/reviews/{id}` | 复盘快照：元信息 + 原始输入 + 最近一次推算结果 |
| PUT | `/api/reviews/{id}` | 整体保存并重新推算 `{base_version, title, events, relations}`；版本过期返回 409 |
| POST | `/api/reviews/{id}/finalize` | 定稿 `{base_version}`；有冲突或暂存事件返回 400 |
| DELETE | `/api/reviews/{id}` | 删除复盘 |

## 目录结构

```
app/
  server.py          HTTP 服务（标准库 http.server）
  db.py              SQLite 持久化、乐观锁、启动时建表
  compute.py         时间窗推算与依据链生成
  static/            浏览器单页界面（原生 HTML/JS/CSS）
tests/test_compute.py  推算引擎单元测试
Dockerfile / docker-compose.yml / .dockerignore
```
