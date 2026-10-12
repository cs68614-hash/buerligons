# buerligons

A user-friendly interactive CAD application

## 本地 OCCT 模式

本 fork 保留原来的建模界面，使用本地 OpenCascade WASM 完成几何计算，运行不需要 ClassCAD key 或 ClassCAD 服务。

```shell
git clone https://github.com/cs68614-hash/buerligons.git
cd buerligons
yarn install --frozen-lockfile --ignore-engines
yarn dev:occt
```

打开终端输出的本地网址。首次安装依赖需要网络，安装后由本地 HTTP 服务提供应用和 WASM，可在本机或内网运行。

已接通基本草图与尺寸、拉伸和布尔、零件 STEP 交换、装配实例与基本配合、实时干涉和拖动防穿透。仍为功能原型，其他原生按钮的支持范围见文档。

- [操作说明与验证记录](OCCT-PILOT.md)
- [未完成事项与已知限制](OCCT-OPEN-ISSUES.md)
- [在线机械设计平台规划](CLASSCAD-ECOSYSTEM-PLAN.md)
- [带孔支架装配示例](examples/bracket-assembly.occt.json)
- [快速拖动防穿透示例](examples/assembly-continuous-collision.occt.json)

通过原生 File → open 打开示例，File → save → occt.json 保存可编辑模型。

```shell
yarn test:occt
yarn build:occt
yarn serve --host 127.0.0.1
```

## 原有 ClassCAD 模式

以下是原项目的 ClassCAD 运行说明；本地 OCCT 模式使用上面的 `dev:occt`／`build:occt` 命令。

First, clone the repository

```shell
git clone https://github.com/awv-informatik/buerligons
cd buerligons
yarn
```

### Create an account and get your ClassCAD key

In order for **buerligons** to work, you need to have a running ClassCAD. You can either run it in the browser using WASM or connect to a local or remote ClassCAD server using SocketIO.

### Running ClassCAD using WASM

Follow the instruction points 1-3 about **"Create an account and get your ClassCAD key"** on [Getting Started with WASM](https://buerli.io/docs/quickstart/wasm).

Copy your created ClassCAD WASM key into the .env file at `CLASSCAD_WASM_KEY=` in the root of this project. The variable `SOCKETIO_URL` is not relevant in this case.

> The first time ClassCAD starts using WASM, loading may take some time depending on your internet speed.

```shell
CLASSCAD_WASM_KEY=MS4xLlZZUG51....
SOCKETIO_URL=ws://localhost:9091
```

### Running ClassCAD using SocketIO

Follow the instruction points 1-3 about **"Create an account, get your ClassCAD key, download ClassCAD"** on [Getting Started with SocketIO](https://buerli.io/docs/quickstart/socketio)

Start ClassCAD via SocketIO as described in the [Downloads](https://classcad.ch/downloads/) page

Open the .env file in the root of this project and comment out `CLASSCAD_WASM_KEY` to make sure ClassCAD is not running using WASM

```shell
#CLASSCAD_WASM_KEY=MS4xLlZZUG51....
SOCKETIO_URL=ws://localhost:9091
```

### Run buerligons

```shell
yarn start
```

The buerligons application is now available at http://localhost:5173.

> Please check the console output for possible node incompatiblities of the development tools. In case of problems, the use of `nvm` is recommended. `nvm` allows installing different Node versions on the same system.

### Links to our homepages and documentations

- [buerligons.io](https://buerligons.io)
- [buerli.io](https://buerli.io)
- [classcad.ch](https://classcad.ch)
- [awv-informatik.ch](https://awv-informatik.ch)
