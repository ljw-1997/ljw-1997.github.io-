/* Reviewed knowledge cards curated from 计算机相关.pdf.
 * Safe to load before app.js. The import is versioned, idempotent and non-destructive.
 */
(function (root) {
  'use strict';
  const BATCH = 'computer-related-pdf-reviewed-v2';
  const CREATED_AT = '2026-11-13T00:00:00.000Z';
  const cards = [
    {
      id: 'pdf-comp-001', title: 'MCU 的组成与片内、片外存储器', category: '嵌入式硬件与存储', sourcePages: '第 1–2 页',
      content: `<h2>1. MCU 是什么</h2><p>MCU（微控制器）通常把处理器内核、总线/互连、片内 Flash、片内 SRAM、时钟/复位逻辑和外设控制器集成在一颗芯片中。不同 MCU 的存储容量、总线结构、外设和启动机制并不相同，具体以目标型号的数据手册、参考手册和勘误表为准。</p>
<h2>2. 三类常见存储角色</h2><ul><li><strong>片内非易失存储器：</strong>常见为嵌入式 Flash，保存启动向量、固件代码、只读常量和需要掉电保留的数据。</li><li><strong>片内 RAM：</strong>保存运行期可读写数据，例如全局变量运行实体、栈、堆、DMA 缓冲区等；普通 SRAM 断电后数据丢失。</li><li><strong>片外存储器：</strong>可为 SPI/QSPI NOR、NAND、SD/eMMC 等，常用于日志、资源文件、固件镜像或扩展内存。能否直接执行取决于器件、控制器和映射方式。</li></ul>
<h2>3. 需要纠正的绝对化说法</h2><p>“程序永远只能在片内 Flash 运行”不成立。部分串行 NOR Flash 可通过 memory-mapped 模式支持 XIP（Execute In Place），处理器可从外部 NOR 取指；NAND 通常需先读入 RAM 再执行。外部存储能否 XIP 还取决于总线映射、控制器、启动 ROM/Bootloader、读延迟和系统配置。</p><p>“RAM 一定比片内 Flash 快、外置 Flash 一定最慢”也不是通用排序。性能取决于存储器时序、总线频率、等待周期、缓存、总线争用、读写方式和控制器配置。</p>
<h2>4. 工程判断顺序</h2><ol><li>确认器件类型：NOR、NAND、SRAM、PSRAM、SD/eMMC。</li><li>查明 CPU 是否能在地址空间中看到该器件。</li><li>确认是否支持指令取指/XIP，以及读写时是否存在 RWW 限制。</li><li>按数据手册配置擦除粒度、编程粒度、时序和保护策略。</li></ol>
<p><strong>记忆：</strong>片内/片外描述物理位置；Flash/RAM 描述存储特性；XIP 描述执行方式。三者不是同一维度。</p>
<p><strong>来源：</strong>原笔记第 1–2 页。补充核验：Micron/存储器厂商资料中的 Serial NOR XIP 与 NAND 读写机制。</p>`
    },
    {
      id: 'pdf-comp-002', title: 'CPU 的取指、译码、执行与关键寄存器', category: '计算机体系结构', sourcePages: '第 3–4、7–8 页',
      content: `<h2>1. 指令执行的基本循环</h2><ol><li><strong>取指（Fetch）：</strong>处理器根据程序计数器 PC 和当前执行状态，从指令存储器取出指令编码。</li><li><strong>译码（Decode）：</strong>识别操作码、寄存器字段、立即数和寻址方式，形成执行控制。</li><li><strong>执行（Execute）：</strong>由整数运算单元、访存单元、分支单元等完成运算、数据读写或控制流改变。</li><li><strong>写回（Write-back）：</strong>将结果写回寄存器或存储器。不同 CPU 的流水线阶段命名和组织会不同。</li></ol>
<h2>2. 常见寄存器</h2><ul><li><strong>PC（Program Counter）：</strong>保存当前/后续取指相关的程序地址。分支、函数调用、异常会改变控制流。</li><li><strong>SP（Stack Pointer）：</strong>指向当前栈的位置；在 Cortex-M 中有 MSP 和 PSP 两个栈指针。</li><li><strong>LR（Link Register）：</strong>在 Arm 调用约定中常用于保存返回地址。</li><li><strong>通用寄存器：</strong>承载运算操作数、地址和临时值。编译器可能把局部变量放寄存器，不一定都放栈。</li><li><strong>状态寄存器：</strong>保存条件标志、执行状态和特权状态等。</li></ul>
<h2>3. 需要纠正的说法</h2><p>PC 不是按 CPU 位数固定 +1/+2/+4。PC 的推进由指令集编码长度和架构语义决定；Cortex-M 执行 Thumb 指令，常见 16 位或 32 位指令，具体取指地址变化应结合反汇编和架构文档理解。</p><p>CPU 内部也不宜简化为“控制器一定是第一个醒来的部件、ALU 完全不工作”。复位是架构定义的硬件状态转换；不同微架构内部控制逻辑的启动细节不是通用编程模型。</p>
<h2>4. 学习建议</h2><p>用调试器单步查看 PC、SP、LR 和通用寄存器；对照反汇编观察 C 代码如何转成加载、存储、算术和分支指令。</p>
<p><strong>来源：</strong>原笔记第 3–4、7–8 页。</p>`
    },
    {
      id: 'pdf-comp-003', title: '地址总线、数据总线、控制信号与 CPU 位宽', category: '计算机体系结构', sourcePages: '第 5–6、19–21 页',
      content: `<h2>1. 总线/互连承担什么工作</h2><ul><li><strong>地址信息：</strong>指出访问目标或事务涉及的地址。</li><li><strong>数据信息：</strong>承载读写数据。</li><li><strong>控制/事务信息：</strong>表达读写方向、访问宽度、传输属性、权限和握手状态等。现代 SoC 常使用分层互连和独立通道，不一定是三根物理“总线”。</li></ul>
<h2>2. CPU 位宽不能简单等同总线宽度</h2><p>“32 位 CPU”通常是对其通用寄存器/指令集数据模型的概括，但具体定义依架构而异。它不保证外部数据总线就是 32 位，也不保证物理地址线恰好 32 根。处理器可能通过更宽/更窄的总线访问存储器，也可能有比寄存器宽度更大的物理地址空间。</p><p>指针大小由目标 ABI、编译器数据模型和地址空间决定，不应仅从“CPU 位数”推断。C 语言中要用 <code>sizeof(void *)</code> 或 <code>sizeof(uintptr_t)</code>（若实现提供）验证当前工具链。</p>
<h2>3. 地址空间与容量的区别</h2><p>32 位字节地址理论上可表示 232 个不同字节地址，即 4 GiB 地址编号空间；这不代表芯片真的安装了 4 GiB RAM。实际只映射其中一部分到 Flash、SRAM、外设、外部存储或保留区。</p>
<h2>4. 工程检查</h2><ol><li>查看 CPU 架构手册确认寄存器、指令和地址属性。</li><li>查看芯片参考手册确认总线矩阵、存储器映射及外设地址。</li><li>查看编译器 ABI 文档与 map 文件确认指针宽度、对齐和实际对象位置。</li></ol>
<p><strong>来源：</strong>原笔记第 5–6、19–21 页。第 19–21 页地址表中的 256 KB Flash、32 KB SRAM 和外设地址未注明芯片型号，不能直接当作通用 MCU 地址配置。</p>`
    },
    {
      id: 'pdf-comp-004', title: 'Cortex-M 复位启动：向量表、MSP、PC 与 Reset_Handler', category: '嵌入式启动与系统架构', sourcePages: '第 7–8、28–35 页',
      content: `<h2>1. Cortex-M 复位入口</h2><p>在典型 Cortex-M 启动模型中，复位时处理器从架构规定的向量表位置取初始栈指针值和复位向量。向量表的第一个字是初始 MSP 值；第二个字是 Reset_Handler 的入口地址（复位向量）。实际映射到该位置的物理存储器由芯片启动配置/地址映射决定，不能把所有 STM32 或 MCU 都写死为 0x08000000。</p>
<h2>2. 典型顺序</h2><ol><li>电源、复位和时钟达到芯片规定的启动条件。</li><li>复位硬件按 Cortex-M 规则读取向量表初始值，初始化 MSP，并从复位向量开始执行。</li><li>执行 Reset_Handler 启动代码；具体启动文件可能调用 SystemInit 配置时钟、总线或内存控制器。</li><li>初始化 C 运行环境：复制有初值的数据段、清零零初始化段，按工具链需要执行运行库初始化。</li><li>进入 <code>main()</code>。</li></ol>
<h2>3. 重要边界</h2><ul><li>复位向量表的地址可能因芯片映射、Boot ROM、启动引脚、别名映射或 VTOR 重定位而变化。</li><li>向量表第二个字最低位用于表示 Thumb 状态，需按架构规定解释；不要把最低位简单当作实际指令字节地址的一部分。</li><li>MSP 和 PSP 是 Cortex-M 两个栈指针；复位时初始化 MSP。PSP 是否启用通常由软件/RTOS 配置。</li><li>SystemInit、C 库入口名称和初始化次序取决于启动模板及工具链，不同工具链可能使用不同符号。</li></ul>
<h2>4. 调试切入点</h2><p>若程序无法进入 main，按顺序检查：启动地址/映射、向量表第 0/1 项、初始 MSP 是否落在有效 RAM、Reset_Handler 地址和 Thumb 状态、时钟初始化、.data/.bss 边界符号、C 运行库入口。</p>
<p><strong>来源：</strong>原笔记第 7–8、28–35 页。参考：<a href="https://documentation-service.arm.com/static/64c7832738511951cb7a246e">Arm Cortex-M 异常模型与向量表说明</a>。</p>`
    },
    {
      id: 'pdf-comp-005', title: 'Flash、RAM 与外部存储：数据保存和执行方式', category: '嵌入式硬件与存储', sourcePages: '第 1–2、10–15、28–29 页',
      content: `<h2>1. Flash 与 RAM 的基本差异</h2><ul><li><strong>Flash：</strong>非易失存储器，掉电通常能保留内容；擦除/编程受器件粒度和时序约束。</li><li><strong>SRAM：</strong>易失性读写存储器，通常用于程序运行数据、栈、堆和缓冲区；掉电丢失。</li><li><strong>外部存储：</strong>其访问方式取决于接口与控制器。SPI/QSPI NOR 可在合适映射模式下 XIP；NAND 多数系统采用读入 RAM 后处理/执行。</li></ul>
<h2>2. XIP 与复制到 RAM 执行</h2><p>XIP（Execute In Place）是从映射存储器直接取指执行，不等于“所有外部 Flash 都能执行”。需要处理器可见的映射地址、支持指令访问的控制器/总线、足够的随机读性能和正确的启动配置。另一种方案是把代码从非易失存储器复制到 RAM 后执行。</p>
<h2>3. RWW（Read While Write）</h2><p>部分 Flash 在擦写某个 Bank 时不能同时从同一 Bank 取指；有些器件支持不同 Bank 并行读写。若擦写期间代码/中断仍需访问被阻塞的 Bank，可能要把关键例程和中断向量/数据放到 RAM，或按器件提供的 Bank 机制安排。不能笼统认定所有内部 Flash 擦写都必须 RAM 执行。</p>
<h2>4. 设计原则</h2><ol><li>根据访问频率和实时性选择代码/数据放置位置。</li><li>核实 cache、预取、总线争用和 DMA 对性能/一致性的影响。</li><li>以目标 Flash 数据手册确认读、页编程、扇区/块擦除和写保护限制。</li></ol>
<p><strong>来源：</strong>原笔记第 1–2、10–15、28–29 页。</p>`
    },
    {
      id: 'pdf-comp-006', title: '程序映像的内存段：.text、.rodata、.data、.bss 与 NOINIT', category: '嵌入式内存模型', sourcePages: '第 10–15 页',
      content: `<h2>1. 常见段的用途</h2><table><thead><tr><th>段/区域</th><th>典型内容</th><th>典型运行位置</th></tr></thead><tbody><tr><td><code>.text</code></td><td>函数机器指令</td><td>Flash 或可执行 RAM</td></tr><tr><td><code>.rodata</code></td><td>只读常量、字符串</td><td>Flash 或其他只读映射区</td></tr><tr><td><code>.data</code></td><td>有初始值的可写全局/静态对象</td><td>运行实体常在 RAM，初始镜像通常在 Flash</td></tr><tr><td><code>.bss</code></td><td>零初始化/未显式初始化的静态存储期对象</td><td>RAM，启动时清零</td></tr><tr><td><code>.noinit</code></td><td>启动时不初始化的保留数据</td><td>按链接/启动配置放入指定 RAM</td></tr></tbody></table>
<h2>2. 三个易错点</h2><ul><li>并非所有 <code>const</code> 对象都必然进入 Flash；编译器、链接脚本、目标 ABI 和实际访问属性决定放置位置。</li><li><code>.bss</code> 常以 ELF <code>SHT_NOBITS</code> 类型表示，只占运行内存空间，不需要保存同等大小的初始字节映像；启动代码负责清零。</li><li><code>.noinit</code> 只表示启动代码不主动初始化该区，不表示它是非易失存储器。能否保留取决于 RAM 供电域、复位类型、芯片行为和启动代码；断电后普通 SRAM 数据会丢失。</li></ul>
<h2>3. 关键概念</h2><p>“存储段/链接段”是工具链和链接脚本层面的组织方式；“Flash/RAM”是物理存储器。两者相关但不是同一层级。项目可使用自定义段放置 DMA 缓冲区、关键代码、共享内存、备份 RAM 数据等。</p>
<p><strong>来源：</strong>原笔记第 10–15 页。</p>`
    },
    {
      id: 'pdf-comp-007', title: 'LMA 与 VMA：链接加载地址和运行地址', category: '编译链接与固件工程', sourcePages: '第 10–11、28–30 页',
      content: `<h2>1. 两个地址分别回答什么问题</h2><ul><li><strong>LMA（Load Memory Address）：</strong>链接映像中某段内容的加载位置，即初始化映像从哪里取得/装载。嵌入式常把 .data 初始值放在 Flash。</li><li><strong>VMA（Virtual Memory Address）：</strong>链接器为段指定的运行地址，即程序运行时该段期望位于的地址。在裸机 MCU 场景通常是 CPU 直接访问的地址。</li></ul>
<p>这里的 VMA 是链接器术语，不等于带 MMU 操作系统里的进程虚拟地址。</p>
<h2>2. 典型映射示例</h2><ul><li><code>.text</code>：常见 LMA=VMA，原地从 Flash 执行。</li><li><code>.rodata</code>：常见 LMA=VMA，位于 Flash。</li><li><code>.data</code>：常见 LMA 在 Flash、VMA 在 RAM；启动代码把初值从 LMA 复制到 VMA。</li><li><code>.bss</code>：通常只有 RAM 中的 VMA，启动代码清零，不需要对应的初始数据 LMA。</li></ul>
<h2>3. 不要把典型布局当成硬规则</h2><p>链接脚本可把代码放入 RAM、把只读数据放入其他存储器，也可为不同 Bank、外部 RAM、TCM 或共享内存设置自定义 LMA/VMA。GNU ld 可用 <code>AT()</code> 或 <code>AT&gt;</code> 指定输出段加载地址；具体以所用链接器文档和 map/ELF 为准。</p>
<h2>4. 启动代码中的典型复制</h2><pre><code>src = __data_load__;   // .data 初始值的加载位置
 dst = __data_start__; // .data 运行位置
 end = __data_end__;
while (dst &lt; end) {
    *dst++ = *src++;
}</code></pre><p>上面是概念伪代码；实际工程的符号名和拷贝宽度由启动文件与链接脚本决定。</p>
<p><strong>来源：</strong>原笔记第 10–11、28–30 页。参考：<a href="https://sourceware.org/binutils/docs/ld/Output-Section-LMA.html">GNU ld：Output Section LMA</a>。</p>`
    },
    {
      id: 'pdf-comp-008', title: 'ELF、MAP、HEX、BIN：固件构建产物如何分工', category: '编译链接与固件工程', sourcePages: '第 10–11、28–34 页',
      content: `<h2>1. 常见产物</h2><ul><li><strong>ELF：</strong>可执行/可重定位目标文件格式家族；最终固件 ELF 可包含段、程序头、符号、重定位、调试信息等，具体内容取决于构建选项。调试器常直接使用 ELF。</li><li><strong>MAP：</strong>链接器生成的布局报告，帮助查看段、符号、地址和占用；它本身通常不是要烧录的固件镜像。</li><li><strong>HEX：</strong>常见为 Intel HEX 文本格式，记录数据及目标地址、记录类型和校验信息，可表达非连续地址区域。</li><li><strong>BIN：</strong>纯字节流，文件本身通常不带绝对加载地址；下载工具需要知道写入基地址。</li></ul>
<h2>2. ELF 到 HEX/BIN</h2><p>objcopy、fromelf 等工具依据目标格式、链接映像和命令选项提取选定的装载内容。不能仅凭“某段有 LMA”就断言它一定进入某个输出文件；要检查转换命令、链接脚本和最终 HEX/BIN 内容。</p>
<h2>3. 如何定位问题</h2><ol><li>ELF：确认 section/program header、符号和调试信息。</li><li>MAP：确认 RAM/Flash 区域占用、符号归属及溢出来源。</li><li>HEX：核对记录地址和实际烧录地址。</li><li>BIN：核对下载工具配置的基地址、长度和填充值。</li><li>烧录后：回读校验或使用调试器核对关键区域。</li></ol>
<p><strong>来源：</strong>原笔记第 10–11、28–34 页。参考：GNU Binutils <a href="https://sourceware.org/binutils/docs/binutils/objcopy.html">objcopy 文档</a>。</p>`
    },
    {
      id: 'pdf-comp-009', title: 'C 程序从源码到目标文件：预处理、编译、汇编与链接', category: '编译链接与固件工程', sourcePages: '第 28、32、34 页',
      content: `<h2>1. 典型工具链流程</h2><ol><li><strong>预处理：</strong>展开头文件、宏和条件编译，常见输出 <code>.i</code>。</li><li><strong>编译：</strong>词法/语法/语义分析和优化，常见可输出汇编 <code>.s</code>，也可直接生成目标文件。</li><li><strong>汇编：</strong>把汇编指令编码为目标文件 <code>.o</code>，包含节区、符号和重定位等信息。</li><li><strong>链接：</strong>合并输入目标文件和库，解析符号/重定位，并按链接脚本安排地址，输出 ELF/MAP 等。</li><li><strong>镜像转换：</strong>按目标烧录要求生成 HEX/BIN 等。</li></ol>
<h2>2. 纠正两个常见误区</h2><ul><li><code>int a = 10;</code> 不保证生成某条固定的 <code>MOV</code> 指令。优化级别、上下文、目标 CPU、寄存器分配和 ABI 都会影响代码。</li><li>目标文件不一定只有四个标准段。常见有 <code>.text</code>、<code>.rodata</code>、<code>.data</code>、<code>.bss</code>，也可能有初始化数组、异常展开、构造表、属性段、重定位段和自定义段。</li></ul>
<h2>3. 可复现查看</h2><pre><code>gcc -E main.c -o main.i   # 仅示意：预处理
arm-none-eabi-gcc -S main.c -o main.s
arm-none-eabi-gcc -c main.c -o main.o
arm-none-eabi-gcc main.o startup.o -T linker.ld -Wl,-Map=app.map -o app.elf
arm-none-eabi-objcopy -O ihex app.elf app.hex</code></pre><p>具体命令需按工具链版本、芯片目标、启动文件和链接脚本调整。</p>
<p><strong>来源：</strong>原笔记第 28、32、34 页。</p>`
    },
    {
      id: 'pdf-comp-010', title: 'Reset_Handler：.data 复制、.bss 清零与 C 运行时初始化', category: '嵌入式启动与系统架构', sourcePages: '第 10–12、28–35 页',
      content: `<h2>1. 为什么需要启动代码</h2><p>复位入口之后，C 程序运行前需要准备语言运行环境。典型 Cortex-M 工程的 Reset_Handler 会设置必要硬件环境，初始化静态存储期对象，然后进入 C 运行库和 <code>main()</code>。</p>
<h2>2. 常见初始化动作</h2><ul><li><strong>设置运行环境：</strong>复位后 MSP 由硬件按向量表初始化；启动代码按项目需要配置时钟、内存控制器等。</li><li><strong>复制 .data：</strong>把存放在非易失映像中的初始化值复制到 RAM 运行地址。</li><li><strong>清零 .bss：</strong>把零初始化静态存储期对象所在 RAM 区域清零。</li><li><strong>运行库初始化：</strong>按工具链执行 C/C++ 运行库初始化，例如 C++ 静态对象构造。</li><li><strong>调用 main：</strong>进入应用逻辑。</li></ul>
<h2>3. 不应死记的部分</h2><p>SystemInit、向量表 VTOR 配置、C 库入口（如 Arm Compiler 的 <code>__main</code>、GCC/newlib 常见的 <code>__libc_init_array</code>）及中断使能策略均依启动模板和项目配置而定。不能把不同工具链的函数名/顺序混为一谈。</p>
<h2>4. 排查 main 未执行</h2><ol><li>确认链接地址和复位向量正确。</li><li>检查 MSP 是否在有效栈区、栈对齐是否符合 ABI。</li><li>检查 .data 的 LMA/VMA 边界符号。</li><li>检查 .bss 清零范围是否越界。</li><li>单步跟踪 SystemInit 和 C 运行库入口。</li></ol>
<p><strong>来源：</strong>原笔记第 10–12、28–35 页。</p>`
    },
    {
      id: 'pdf-comp-011', title: 'RAM 区域占用与 Keil L6220E 溢出诊断', category: '编译链接与固件工程', sourcePages: '第 12 页',
      content: `<h2>1. L6220E 常见含义</h2><p>在 Arm/Keil 链接器环境中，L6220E 常见为某个执行区域/内存区域容量超出配置上限。需结合完整错误信息、链接脚本/Scatter 文件和 map 文件判断究竟是哪一个区域超限。</p>
<h2>2. RAM 占用通常包括</h2><ul><li><code>.data</code>：有初始值的全局/静态对象的运行实体。</li><li><code>.bss</code>：零初始化或未显式初始化的全局/静态对象。</li><li>用户显式放入 RAM 的自定义段，例如 DMA 缓冲区、共享区、RAM 代码、缓存区。</li><li>栈/堆：是否以及如何计入链接区域由启动文件、Scatter 文件和链接器配置决定。</li><li>对齐填充和链接器生成的元数据/控制块。</li></ul>
<h2>3. 排查方法</h2><ol><li>在 map 中看执行区域大小、已用大小和剩余大小。</li><li>按 section 和 symbol 排序，找出最大数组、缓冲区和静态对象。</li><li>检查 Stack_Size/Heap_Size 是否合理，以及是否有不需要的预留。</li><li>检查 section 对齐、内存属性和自定义段是否放错区域。</li><li>通过减小缓冲区、优化存储类型、复用生命周期不重叠的缓冲区或调整芯片资源解决；不要盲目删除对齐。</li></ol>
<h2>4. Padding 不一定是浪费</h2><p>填充可能是为了满足 CPU/ABI 对齐、DMA、cache line 或外设访问要求。只有确认不影响正确性与性能后，才考虑调整数据布局。</p>
<p><strong>来源：</strong>原笔记第 12 页。</p>`
    },
    {
      id: 'pdf-comp-012', title: '栈、堆、函数栈帧与 Cortex-M 调用约定', category: 'C 语言与内存模型', sourcePages: '第 12、14、28–29 页',
      content: `<h2>1. 栈与堆</h2><ul><li><strong>栈：</strong>支持函数调用、保存寄存器、局部存储和异常现场。生命周期通常与调用/任务上下文相关。</li><li><strong>堆：</strong>由动态分配器管理，供 <code>malloc/free</code> 等使用；是否使用由项目策略决定。堆增长方向不是 C 语言统一规定的。</li><li><strong>栈增长方向：</strong>常见 Cortex-M ABI 使用递减栈，但要以目标架构、ABI 和启动配置为准。</li></ul>
<h2>2. Cortex-M 常见寄存器约定</h2><p>Cortex-M 使用 R0–R15 核心寄存器；R13 是 SP，R14 是 LR，R15 是 PC。AAPCS32 通常使用 R0–R3 传递前几个整型参数/返回值，更多参数可能通过栈传递；R4–R11 等寄存器有被调用者保存规则。具体以 ABI 变体（如是否启用浮点 ABI）为准。</p>
<h2>3. 栈帧不是固定模板</h2><p>函数调用时，编译器可能调整 SP、保存 LR/被调用者保存寄存器、分配局部栈空间；也可能把局部变量放入寄存器、内联函数或省略帧指针。优化后不一定能看到传统“EBP/ESP 栈帧”。</p>
<h2>4. Cortex-M 异常栈帧</h2><p>异常进入时，硬件会自动压入基本现场（常见包括 R0–R3、R12、LR、PC、xPSR）；具体压入 MSP 还是 PSP 取决于异常前使用的栈和处理模式。启用浮点扩展时还可能有扩展现场，并可能因对齐产生额外空间。</p>
<h2>5. 代码审查重点</h2><ul><li>避免深递归和过大的局部数组。</li><li>测量任务栈水位并设置安全余量。</li><li>明确 ISR 使用哪个栈、是否允许浮点。</li><li>动态分配时检查失败、碎片、所有权和释放路径。</li></ul>
<p><strong>来源：</strong>原笔记第 12、14、28–29 页。参考：<a href="https://github.com/ARM-software/abi-aa/blob/main/aapcs32/aapcs32.rst">Arm AAPCS32</a>。</p>`
    },
    {
      id: 'pdf-comp-013', title: '内存地址、指针、数据类型与 Load/Store', category: 'C 语言与内存模型', sourcePages: '第 13、22–24 页',
      content: `<h2>1. 字节编址</h2><p>多数通用 MCU/CPU 使用字节编址：相邻字节的地址相差 1。地址标识存储位置；数据类型描述 C 对象的大小、表示、对齐和操作规则。</p>
<h2>2. 指针类型的意义</h2><p><code>uint8_t *</code>、<code>uint16_t *</code>、<code>uint32_t *</code> 的指针算术步长分别为对应对象大小；解引用时的访问类型也影响编译器选择的加载/存储操作。但实际访问指令由编译器和目标 ISA 决定，不应认为“CPU 根据指针类型临时决定读几字节”。</p>
<h2>3. C 类型大小的可移植性</h2><ul><li><code>sizeof(char)</code> 永远为 1（一个 C byte），但一个 byte 的 bit 数由 <code>CHAR_BIT</code> 定义，常见 MCU 为 8。</li><li><code>sizeof(int)</code>、指针宽度、对齐等依实现和 ABI 决定，不应只凭“32 位 CPU”推断。</li><li>需要固定宽度数据时使用 <code>uint8_t</code>、<code>uint16_t</code>、<code>uint32_t</code> 等（实现提供时），并明确范围和协议编码。</li></ul>
<h2>4. 例子</h2><pre><code>uint32_t value = 0x12345678u;
uint32_t *p32 = &amp;value;
uint8_t  *p8  = (uint8_t *)&amp;value;

uint32_t copy = *p32;   // 按 uint32_t 对象类型访问
uint8_t first = p8[0];  // 查看对象表示的第一个字节</code></pre><p>通过字符类型访问对象表示是 C 中的特殊允许路径；但不能随意把任意地址转换成指针并解引用，必须保证地址有效、对齐满足要求、对象生命周期和访问类型合法。</p>
<p><strong>来源：</strong>原笔记第 13、22–24 页。</p>`
    },
    {
      id: 'pdf-comp-014', title: '大小端、字节序与 CAN/DBC 信号解析', category: 'C 语言与内存模型', sourcePages: '第 25 页',
      content: `<h2>1. CPU 字节序</h2><ul><li><strong>小端：</strong>多字节对象的最低有效字节放在较低地址。</li><li><strong>大端：</strong>多字节对象的最高有效字节放在较低地址。</li></ul>
<p>字节序描述的是一个多字节对象的字节排列。单个 <code>uint8_t</code> 字节没有内部字节顺序；数组元素仍按下标顺序连续排列，字节序影响的是每个多字节元素内部的字节布局。</p>
<h2>2. 示例</h2><p>若 32 位数值为 <code>0x12345678</code>，小端内存地址从低到高可见 <code>78 56 34 12</code>；大端可见 <code>12 34 56 78</code>。这是对象在内存中的表示，不代表网络/总线协议必然使用相同顺序。</p>
<h2>3. CAN/DBC 与 MCU 字节序不是一回事</h2><p>DBC 的 Intel/Motorola 信号字节序、起始位编号和信号位排列属于协议定义；必须按 DBC 规则解释报文中的 bit。不能直接把“MCU 小端”推导成“CAN 信号小端”。CAN 帧数据载荷通常是按字节传输，应用层信号如何跨字节组装由协议数据库决定。</p>
<h2>4. 稳妥的解析方式</h2><pre><code>uint16_t read_le16(const uint8_t *p)
{
    return (uint16_t)p[0] | ((uint16_t)p[1] &lt;&lt; 8);
}

uint16_t read_be16(const uint8_t *p)
{
    return ((uint16_t)p[0] &lt;&lt; 8) | (uint16_t)p[1];
}</code></pre><p>对多字节协议字段优先显式移位/掩码解码，避免直接把接收缓冲区强转为结构体指针。</p>
<h2>5. 检查大小端</h2><p>可用 <code>memcpy</code> 将对象表示复制到 <code>uint8_t</code> 数组后检查，也可在明确目标编译器规则的嵌入式代码中使用 union 方法；跨平台库更推荐显式序列化/反序列化。</p>
<p><strong>来源：</strong>原笔记第 25 页。</p>`
    },
    {
      id: 'pdf-comp-015', title: '结构体对齐与填充：sizeof、offsetof 和协议布局', category: 'C 语言与内存模型', sourcePages: '第 26 页',
      content: `<h2>1. 为什么有填充</h2><p>对象类型有对齐要求。编译器可能在结构体成员之间或末尾插入 padding，使每个成员满足目标 ABI 的对齐规则，并使数组中相邻结构体对象的起始地址都满足对齐。</p>
<h2>2. 常见例子（不是语言保证）</h2><pre><code>struct Example {
    char    a;
    int32_t b;
};</code></pre><p>在许多 32 位 ABI 上，<code>a</code> 位于偏移 0，<code>b</code> 可能被放到偏移 4，中间出现 3 字节填充，结构体大小可能为 8 字节。但这取决于 <code>int32_t</code> 的对齐要求、ABI 和编译器设置，不能把 8 当成所有平台的保证。</p>
<h2>3. 如何验证</h2><pre><code>printf("sizeof=%zu\\n", sizeof(struct Example));
printf("a=%zu, b=%zu\\n",
       offsetof(struct Example, a),
       offsetof(struct Example, b));</code></pre><p>C11 可用 <code>_Alignof</code> 查询类型对齐（C++ 使用 <code>alignof</code>）。</p>
<h2>4. 协议/文件格式不要直接写裸结构体</h2><p>把网络报文、CAN 数据、Flash 持久化格式直接映射为 C 结构体，可能受 padding、端序、位域布局、对齐、编译器 ABI 影响。更稳妥的方式是显式编码/解码每个字段。<code>packed</code> 等扩展会改变对齐，可能引起未对齐访问、性能下降或总线错误，必须确认目标支持并测量。</p>
<p><strong>来源：</strong>原笔记第 26 页。参考：C11 草案 6.2.8 和 6.7.2.1 对齐与结构体成员布局规定。</p>`
    },
    {
      id: 'pdf-comp-016', title: 'NAND Flash 的 Page、Block、Page Cache 与换页', category: '嵌入式硬件与存储', sourcePages: '第 16 页',
      content: `<h2>1. 基本组织</h2><ul><li><strong>Page（页）：</strong>NAND 的常见读取和编程单位。页面大小与 spare/OOB 区大小依芯片而定。</li><li><strong>Block（块）：</strong>由多个页组成，常见擦除粒度是块，不能像 RAM 一样按任意字节覆盖。</li><li><strong>Page Cache/Register：</strong>NAND 芯片内部通常有数据寄存器/缓存寄存器，读命令会把阵列中的页数据加载到寄存器，再通过接口读取；编程也常先装载数据再执行 Page Program。</li></ul>
<h2>2. 跨页访问</h2><p>访问跨页地址时，控制器或驱动需要按器件命令集组织新的页地址/读写操作。某些器件支持 cache read/cache program 等连续操作，读出列地址或数据方式也有差异。不能说软件必须手工把“整页复制到唯一托盘”才可读取，也没有统一的换页微秒开销。</p>
<h2>3. NAND 驱动必须关注</h2><ul><li>Page Program 的对齐、页内最大编程次数和时序。</li><li>Block Erase、坏块标记和坏块管理。</li><li>ECC、OOB/spare 区布局、数据校验。</li><li>磨损均衡、掉电保护、写放大和文件系统一致性。</li></ul>
<h2>4. 与 NOR 的差异</h2><p>NAND 通常适合较高密度的大容量数据存储，通常不直接 XIP；NOR 更适合随机读取和固件代码存储，在适当接口映射下可支持 XIP。二者不能只用“速度高低”概括。</p>
<p><strong>来源：</strong>原笔记第 16 页。具体操作必须以 NAND 型号数据手册的 Read/Program/Erase、Cache 和 ECC 章节为准。</p>`
    },
    {
      id: 'pdf-comp-017', title: 'NOR Flash：擦除、编程粒度与外部 XIP', category: '嵌入式硬件与存储', sourcePages: '第 1–2、28–29 页',
      content: `<h2>1. NOR Flash 的常见约束</h2><ul><li>擦除通常按 Sector/Block 等较大粒度执行。</li><li>编程通常按器件规定的最小编程单位和页边界执行。</li><li>常见 NOR 单元编程方向是从擦除态 1 编程为 0；若要把 0 改回 1，通常需要擦除所在扇区/块后重新写入。</li><li>状态寄存器、写使能、写保护、忙状态和擦除/编程超时均要正确处理。</li></ul>
<h2>2. 不同 NOR 器件并不完全一样</h2><p>内部片上 Flash、并行 NOR、SPI/QSPI/Octal NOR 的命令、地址宽度、页大小、擦除块、编程单位和保护寄存器可能不同。不能照搬一个芯片的“32 位写/256B 页/4KB 扇区”到另一个器件。</p>
<h2>3. 外部 NOR XIP</h2><p>如果 MCU/SoC 的 QSPI/OSPI 控制器提供 memory-mapped 读模式，并且处理器支持对该窗口取指，则可从外部 NOR XIP。写/擦除期间能否继续从同一器件取指，需查控制器和器件限制；常见做法是将 Flash 操作代码、必要中断和常量移到 RAM，或安排不同 Bank。</p>
<h2>4. 驱动流程检查</h2><ol><li>解锁/写使能。</li><li>确认地址、长度、页边界和擦除范围。</li><li>执行擦除或编程并轮询/等待忙状态。</li><li>检查状态寄存器和错误标志。</li><li>回读校验，必要时锁定写保护。</li></ol>
<p><strong>来源：</strong>原笔记第 1–2、28–29 页。</p>`
    },
    {
      id: 'pdf-comp-018', title: 'Flash Driver：硬件约束封装、RWW 与可靠性', category: '嵌入式驱动与可靠性', sourcePages: '第 1–2、12、28–29 页',
      content: `<h2>1. Flash Driver 的职责</h2><p>Flash Driver 是软件层对底层控制器/存储器命令的封装，为上层提供初始化、读、编程、擦除、状态查询和错误码等接口，并集中管理器件时序、地址范围、对齐、保护和超时要求。</p>
<h2>2. 通用驱动设计要素</h2><ul><li>器件识别和能力参数：容量、页大小、擦除扇区、状态寄存器。</li><li>范围与边界检查：防越界、越分区、越页写入。</li><li>擦除/编程状态机：忙等待带超时，错误位可诊断。</li><li>数据完整性：CRC/哈希/回读校验，按产品需求做冗余和掉电恢复。</li><li>并发保护：避免多个任务同时操作同一 Flash 控制器。</li></ul>
<h2>3. 读写不总是“先擦后写”</h2><p>Flash 通常要求先擦除再把擦除态写成目标数据，但器件也可能允许对同一已擦页执行受限次数的 1→0 编程。是否需要每次写前擦除、能否部分编程和最小粒度，必须以芯片手册为准。</p>
<h2>4. RWW 风险</h2><p>擦写时若当前代码、常量或中断处理程序需要访问受影响的 Flash Bank，可能发生停顿或异常。解决方案可包括 RAM 函数、RAM 中断向量/常量、双 Bank 方案和临界区；需要按芯片 RWW 章节设计。</p>
<p><strong>来源：</strong>原笔记第 1–2、12、28–29 页。</p>`
    },
    {
      id: 'pdf-comp-019', title: 'Bootloader 与固件升级：镜像、校验和回滚', category: '嵌入式启动与系统架构', sourcePages: '第 1–2、28–30、33–34 页',
      content: `<h2>1. Bootloader 是什么</h2><p>Bootloader 是启动早期运行的软件，负责选择启动镜像、检查升级请求、验证固件并跳转到应用程序。它可能位于片内 Flash、ROM 或安全启动链的其他阶段，分区与执行方式取决于芯片。</p>
<h2>2. 常见升级数据路径</h2><p>外部存储中的候选固件可先通过总线读入 RAM 缓冲区，再写入片内 Flash 应用区；也可能直接从通信接口流式写入，或利用双 Bank/双槽位更新。是否需要整包放入 RAM，取决于分区容量、接口带宽和擦写策略。</p>
<h2>3. 建议的安全流程</h2><ol><li>获取镜像元数据：产品型号、硬件版本、软件版本、长度、目标分区。</li><li>验证镜像真实性和完整性：签名验证优先，CRC 仅能检测传输/存储差错，不能替代认证。</li><li>检查电源、温度、剩余空间和升级条件。</li><li>擦除目标区域，按 Flash 编程粒度写入。</li><li>回读/校验镜像，更新启动标志或元数据。</li><li>重启后由 Bootloader 再次验证，失败时回滚到已知可启动版本。</li></ol>
<h2>4. 跳转到应用前</h2><p>需要按芯片/内核规范处理 MSP、应用复位向量、VTOR、中断使能、SysTick、外设状态、Cache/MPU 和时钟状态。不能只把 PC 改为应用入口地址就认为跳转安全。</p>
<p><strong>来源：</strong>原笔记第 1–2、28–30、33–34 页。</p>`
    },
    {
      id: 'pdf-comp-020', title: '虚拟内存、页表、MMU 与 TLB', category: '计算机体系结构', sourcePages: '第 17–18 页',
      content: `<h2>1. 虚拟地址与物理地址</h2><p>支持 MMU 的处理器/操作系统可为进程提供独立虚拟地址空间。程序使用虚拟地址，MMU 根据页表和访问权限将其转换到物理地址；未映射或权限不符可能触发页故障/异常。</p>
<h2>2. 页表和 TLB</h2><ul><li><strong>页表：</strong>保存虚拟页到物理页框的映射、权限和属性等信息，通常驻留在物理内存中。</li><li><strong>页表基址寄存器：</strong>架构相关；x86 常见 CR3，Arm A-profile/AArch64 使用 TTBR 等。</li><li><strong>TLB：</strong>缓存近期地址转换结果，减少页表遍历开销；它是处理器/MMU 内部的硬件转换缓存，不是“页表本身”。</li></ul>
<h2>3. 不要把页表访问简化成绝对规则</h2><p>页表遍历由体系结构规定的硬件机制完成，具体访问路径、缓存和多级转换可能复杂；在虚拟化场景还可能有 Stage-2 地址转换。可以用“页表基址寄存器帮助硬件定位页表”建立初步理解，但不应把所有架构都概括成固定的一步物理访问流程。</p>
<h2>4. Cortex-M 的区别</h2><p>多数 Cortex-M MCU 使用直接内存映射，常见提供可选 MPU（内存保护单元）而不是支持进程虚拟地址空间的 MMU。MMU/虚拟内存知识主要用于 Cortex-A 等应用处理器和带操作系统的系统；不能把 x86/Linux 的页表概念直接套到普通 Cortex-M。</p>
<p><strong>来源：</strong>原笔记第 17–18 页。参考：Arm 架构寄存器与对应操作系统内存管理文档。</p>`
    },
    {
      id: 'pdf-comp-021', title: 'Cortex-M 内存映射：架构区域不等于芯片实际容量', category: '嵌入式启动与系统架构', sourcePages: '第 19–21 页',
      content: `<h2>1. Cortex-M 常见默认地址区域（示例）</h2><table><thead><tr><th>地址范围</th><th>常见区域名</th></tr></thead><tbody><tr><td><code>0x00000000–0x1FFFFFFF</code></td><td>Code</td></tr><tr><td><code>0x20000000–0x3FFFFFFF</code></td><td>SRAM</td></tr><tr><td><code>0x40000000–0x5FFFFFFF</code></td><td>Peripheral</td></tr><tr><td><code>0x60000000–0x9FFFFFFF</code></td><td>External RAM</td></tr><tr><td><code>0xA0000000–0xDFFFFFFF</code></td><td>External Device</td></tr><tr><td><code>0xE0000000–0xE00FFFFF</code></td><td>PPB（核心私有外设）</td></tr></tbody></table>
<p>这是 Cortex-M 常见架构默认内存映射的区域划分示例，不代表每颗 MCU 都实际实现这些区域，更不表示每个区域都对应真实物理存储器。更高地址的系统/厂商区域还可能因内核版本而不同。</p>
<h2>2. 原笔记中需要纠正的点</h2><p><code>0x60000000–0x9FFFFFFF</code> 常见为 External RAM 区；<code>0xA0000000–0xDFFFFFFF</code> 常见为 External Device 区，不应把两者全部标成“无对应硬件的 reserved 区”。这些区域是否连有外部设备由 SoC/芯片实现决定。</p>
<h2>3. 具体芯片地址表</h2><p>原笔记列出的 256 KB Flash、32 KB SRAM、Flash Config 区和 APB/AHB 外设地址没有注明 MCU 型号。因此只能保留为“某个未标明目标芯片的示例”，不能用来配置真实工程。实际应从芯片 Reference Manual 的 Memory Map、Datasheet 的 memory size 和 linker/scatter 文件核对。</p>
<h2>4. MPU 与 MMU</h2><p>MPU 主要提供区域属性和访问权限控制；它通常不创建进程虚拟地址空间，也不执行页表式虚拟到物理地址转换。多数 Cortex-M 场景讨论内存保护时应先看 MPU，而不是直接引入 MMU 页表。</p>
<p><strong>来源：</strong>原笔记第 19–21 页。参考：<a href="https://documentation-service.arm.com/static/5f2ac4ab60a93e65927bbdbf">Arm Cortex-M4 Generic User Guide</a>。</p>`
    }
    ,{
      id: 'pdf-comp-022', title: 'volatile、内存映射 I/O 与原子性边界', category: 'C 语言与内存模型', sourcePages: '补充知识（关联第 5、20–21、28–29 页）',
      content: `<h2>1. volatile 的作用</h2><p><code>volatile</code> 告诉编译器：对该对象的访问具有可观察副作用，不能随意把访问删掉或只把值长期缓存到寄存器。它常用于内存映射外设寄存器、硬件状态寄存器以及由中断/硬件异步改变的对象。</p>
<h2>2. volatile 不保证什么</h2><ul><li>不保证复合操作原子性：<code>count++</code> 仍可能是读—改—写多个步骤。</li><li>不自动建立线程/任务间同步关系，也不等价于互斥锁或 C11 原子类型。</li><li>不自动清理/失效 CPU Cache，也不自动完成 DMA 一致性。</li><li>不等于 CPU 内存屏障，不能把它当成所有读写排序的通用解决方案。</li></ul>
<h2>3. MMIO 的访问原则</h2><p>外设寄存器通常映射到处理器地址空间。优先使用芯片厂商/CMSIS 定义的寄存器结构、地址和访问类型；确认寄存器宽度、读写副作用、保留位和写 1 清零（W1C）等语义。不要对寄存器做未经手册确认的普通读—改—写。</p>
<h2>4. 原子操作与屏障</h2><ul><li>任务间共享数据：优先使用 RTOS 互斥量、队列、临界区或适用的 C 原子操作。</li><li>ISR 与主循环共享数据：根据数据宽度、对齐、指令原子性和目标芯片规则设计；必要时用短临界区或原子操作。</li><li>需要约束 CPU/总线访问顺序时，按架构使用 DMB/DSB/ISB；它们的语义不同，不能互换。</li></ul>
<h2>5. 典型审查问题</h2><ol><li>这个变量是否可能被硬件/ISR 异步改变？</li><li>读写宽度是否对目标内核原子？</li><li>是否存在读改写竞争或寄存器读副作用？</li><li>是否需要任务同步、CPU 屏障或 Cache 维护？</li></ol>
<p><strong>参考：</strong><a href="https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/recommendations/concurrency-con/con02-c/">SEI CERT C CON02-C：不要用 volatile 作为同步原语</a>。</p>`
    },
    {
      id: 'pdf-comp-023', title: 'DMA 缓冲区、D-Cache 一致性与内存屏障', category: '嵌入式驱动与可靠性', sourcePages: '补充知识（关联第 12、15、19–21 页）',
      content: `<h2>1. DMA 与 CPU 是两个访问主体</h2><p>DMA 控制器可以在不让 CPU 逐字节搬运的情况下访问 RAM。CPU 可能通过 D-Cache 读写同一地址；DMA 通常直接访问系统内存。因此当存在数据缓存时，CPU 缓存中的副本与 RAM 中的数据可能不一致。</p>
<h2>2. 常见缓存维护方向</h2><ul><li><strong>CPU 写缓冲区 → DMA 读取（Memory-to-Peripheral）：</strong>DMA 启动前，按平台要求 clean 对应 D-Cache 行，确保脏数据写回 RAM。</li><li><strong>DMA 写 RAM → CPU 读取（Peripheral-to-Memory）：</strong>DMA 完成后，CPU 读取前按平台要求 invalidate 对应 Cache 行，避免读取旧缓存副本。</li><li><strong>双向/复用缓冲区：</strong>需要按所有权交接阶段设计 clean/invalidate 顺序，避免丢失 CPU 尚未写回的脏数据。</li></ul>
<h2>3. 对齐与隔离</h2><p>缓存维护通常按 Cache Line 粒度进行。缓冲区起始地址、长度和相邻变量布局应满足目标内核/库函数要求；避免把 DMA 缓冲区与其他频繁修改的数据放在同一 Cache Line，防止失效操作误伤相邻脏数据。Cache Line 大小和 CMSIS API 对齐要求必须查目标内核手册。</p>
<h2>4. RAM 区域也要选对</h2><p>不是每块 RAM 都一定被所有 DMA 主设备访问。例如某些 TCM/CCM 或特殊 SRAM 可能不在 DMA 可达路径。必须查芯片总线矩阵、DMA 主设备可访问性、地址对齐和数据宽度约束。</p>
<h2>5. 一个安全的工程清单</h2><ol><li>确认目标 MCU 是否实现 D-Cache，以及 Cache Line 大小。</li><li>确认 DMA 能访问缓冲区所在 RAM 区域。</li><li>按传输方向安排 clean/invalidate，使用厂商/CMSIS 提供的维护接口。</li><li>处理描述符、缓冲区的内存顺序与所有权交接，必要时加架构屏障。</li><li>无 D-Cache 的芯片仍需检查 DMA 可访问区域、对齐、总线竞争和缓存外设自身限制。</li></ol>
<p><strong>参考：</strong><a href="https://arm-software.github.io/CMSIS_5/Core/html/group__Dcache__functions__m7.html">CMSIS D-Cache 维护函数</a>；具体以芯片参考手册为准。</p>`
    }

  ];

  const clone = (value) => JSON.parse(JSON.stringify(value));
  function stripEditorialPreamble(content) {
    return String(content || '').replace(/^\s*<p>\s*<strong>(?:校订状态|内容属性)：<\/strong>[\s\S]*?<\/p>\s*/i, '');
  }
  function isPristineSeedNote(note) {
    if (!note || note.importBatch !== BATCH) return false;
    const card = cards.find((item) => item.id === note.id);
    if (!card) return false;
    return note.title === card.title && note.category === card.category && stripEditorialPreamble(note.content) === card.content && note.createdAt === CREATED_AT && !note.updatedAt;
  }
  function importIntoState(target) {
    if (!target || typeof target !== 'object') throw new Error('知识库导入目标状态无效。');
    if (!Array.isArray(target.notes)) target.notes = [];
    // Remove editorial workflow labels from cards created by earlier versions.
    // Only the leading status paragraph of this import batch is touched; user edits remain intact.
    let cleaned = 0;
    target.notes.forEach((note) => {
      if (!note || note.importBatch !== BATCH || typeof note.content !== 'string') return;
      const next = stripEditorialPreamble(note.content);
      if (next !== note.content) { note.content = next; cleaned += 1; }
    });
    const markers = Array.isArray(target.importedKnowledgeSets) ? target.importedKnowledgeSets : [];
    if (markers.includes(BATCH)) return { added: 0, alreadyImported: true, cleaned };
    const ids = new Set(target.notes.map((note) => note && note.id).filter(Boolean));
    let added = 0;
    cards.forEach((card) => {
      if (ids.has(card.id)) return;
      target.notes.push({
        ...clone(card),
        createdAt: CREATED_AT,
        custom: true,
        importBatch: BATCH,
        sourceDocument: '计算机相关.pdf',
        reviewed: true
      });
      ids.add(card.id);
      added += 1;
    });
    target.importedKnowledgeSets = [...markers, BATCH];
    return { added, alreadyImported: false, cleaned };
  }
  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
  }
  function isImportOnlyDifference(localState, remoteState) {
    if (!localState || !remoteState || typeof localState !== 'object' || typeof remoteState !== 'object') return false;
    const comparable = (source) => {
      const result = clone(source);
      result.notes = (Array.isArray(result.notes) ? result.notes : []).filter((note) => !isPristineSeedNote(note));
      result.importedKnowledgeSets = (Array.isArray(result.importedKnowledgeSets) ? result.importedKnowledgeSets : []).filter((key) => key !== BATCH);
      return JSON.stringify(canonicalize(result));
    };
    return comparable(localState) === comparable(remoteState);
  }

  root.EMBEDDED_COMPUTER_KNOWLEDGE = {
    batch: BATCH,
    cards: cards,
    importIntoState: importIntoState,
    isImportOnlyDifference: isImportOnlyDifference,
    pristineSeedCount: cards.length
  };
})(typeof window !== 'undefined' ? window : globalThis);
