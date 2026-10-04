# Third-party notices

Mneme Bridge 依赖以下第三方软件。它们的许可证与本项目（MIT）兼容，此处保留其版权声明。

## dsh-mneme

- 项目：https://github.com/slow-stack/mneme
- 许可证：MIT
- 用途：本项目的**记忆基座**。mneme 运行在 DSH 内，提供记忆的存储、去重合并、冲突裁决与语义检索；
  Mneme Bridge 通过其 API 读写同一份记忆库，不复制、不修改其代码。

```
MIT License

Copyright (c) dsh-mneme contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## DeepSeek Harness (DSH)

- 项目：https://github.com/deepseek-ai/dsh
- 用途：宿主程序。mneme 作为其插件运行，本项目的桥接服务调用 DSH 的 headless 模式完成对话蒸馏。
- 本项目不包含 DSH 的任何代码。
