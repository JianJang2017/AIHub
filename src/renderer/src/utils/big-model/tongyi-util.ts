import { CommonChatOption, CommonDrawingOption } from '.'
import { EventStreamContentType, fetchEventSource } from '@microsoft/fetch-event-source'
import { limitContext, turnChat } from '@renderer/utils/big-model/base-util'
import { randomUUID } from '@renderer/utils/id-util'
import { executeJavaScript, saveFileByUrl } from '@renderer/utils/ipc-util'
import { Logger } from '@renderer/utils/logger'

// 根据模型获取服务地址
export const getTongyiChatUrl = (model: string) => {
  switch (model) {
    case 'qwen-turbo':
    case 'qwen-plus':
    case 'qwen-max':
    case 'qwen-max-longcontext':
      return 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation'
    case 'qwen-vl-plus':
      return 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
    default:
      return ''
  }
}

export const chat2tongyi = async (option: CommonChatOption) => {
  const {
    model,
    instruction,
    inputMaxTokens,
    maxTokens,
    contextSize,
    apiKey,
    abortCtr,
    messages,
    sessionId,
    chatPlugins,
    startAnswer,
    appendAnswer,
    end
  } = option

  // 等待回答
  let waitAnswer = true

  // 回答字符串返回索引
  let answerIndex = 0

  // 是否有插件
  let pluginAnswer: any = null
  if (chatPlugins && chatPlugins.length > 0) {
    const chatPluginResponse = await fetch(getTongyiChatUrl(model), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        input: {
          messages: await getTongyiMessages(
            messages!,
            instruction,
            inputMaxTokens,
            contextSize,
            model
          )
        },
        parameters: {
          output_tokens: maxTokens,
          result_format: 'message',
          tools: chatPlugins.map((p) => {
            return {
              type: p.type,
              function: {
                name: p.id,
                description: p.description,
                parameters: {
                  type: 'object',
                  properties: p.parameters.reduce((acc, param) => {
                    acc[param.name] = {
                      type: param.type,
                      description: param.description
                    }
                    return acc
                  }, {}),
                  required: p.parameters.map((param) => param.name)
                }
              }
            }
          })
        }
      })
    })

    pluginAnswer = await chatPluginResponse.json()
  }

  // 现有消息列表
  const chatMessages = await getTongyiMessages(
    messages!,
    instruction,
    inputMaxTokens,
    contextSize,
    model
  )

  // 是否有插件
  if (chatPlugins && pluginAnswer && pluginAnswer.output.choices[0].message.tool_calls) {
    // 插件运行
    const pluginId = pluginAnswer.output.choices[0].message.tool_calls[0].function.name
    const pluginParams = pluginAnswer.output.choices[0].message.tool_calls[0].function.arguments
    const pluginResult = await executeJavaScript(
      `var params = ${pluginParams};${chatPlugins.find((p) => p.id === pluginId)?.code}`
    )
    Logger.info('chat2tongyi pluginResult: ', pluginResult)
    // 插件回复
    chatMessages.push(pluginAnswer.output.choices[0].message)
    chatMessages.push({
      role: 'tool',
      name: pluginId,
      content: pluginResult
    })
  }

  // sse
  await fetchEventSource(getTongyiChatUrl(model), {
    openWhenHidden: true, // 保持后台运行
    signal: abortCtr?.signal,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify({
      model,
      input: {
        messages: chatMessages
      },
      parameters: {
        output_tokens: maxTokens,
        result_format: 'message',
        enable_search: true
      }
    }),
    // 连接开启
    async onopen(response) {
      if (response.ok && response.headers.get('content-type')?.includes(EventStreamContentType)) {
        return
      } else {
        const respText = await response.text()
        Logger.info('chat2tongyi error', respText)
        throw new Error(respText)
      }
    },
    onmessage: (message) => {
      try {
        const respJson = JSON.parse(message.data)
        Logger.info('chat2tongyi:', respJson)
        let content: string
        if (model === 'qwen-vl-plus') {
          content = respJson.output.choices[0].message.content[0].text
        } else {
          content = respJson.output.choices[0].message.content
        }
        if (waitAnswer) {
          waitAnswer = false
          startAnswer && startAnswer(sessionId)
        }
        appendAnswer && appendAnswer(sessionId, content.substring(answerIndex))
        answerIndex = content.length
      } catch (e: any) {
        Logger.error('chat2tongyi error', e?.message)
        end && end(sessionId, message.data)
      }
    },
    // 连接关闭
    onclose: () => {
      Logger.info('chat2tongyi close')
      end && end(sessionId)
    },
    // 连接错误
    onerror: (e: any) => {
      Logger.error('chat2tongyi error：', e?.message)
      // 抛出异常防止重连
      if (e instanceof Error) {
        throw e
      }
    }
  })
}

export const getTongyiMessages = async (
  chatMessageList: ChatMessage[],
  instruction: string,
  inputMaxTokens: number | undefined,
  contextSize: number,
  model: string
) => {
  // 将消息历史处理为user和assistant轮流对话
  let messages = turnChat(chatMessageList)

  // 截取指定长度的上下文
  messages = limitContext(inputMaxTokens, contextSize, messages)

  // 增加指令
  if (instruction.trim().length > 0) {
    messages.unshift({
      role: 'system',
      content: instruction
    })
  }

  // 消息开头不能是 assistant
  if (messages[0].role === 'assistant') {
    messages.shift()
  }

  // qwen-vl-plus 模型消息格式处理
  if (model === 'qwen-vl-plus') {
    return messages.map((msg) => {
      return { role: msg.role, content: [{ text: msg.content }] }
    })
  }

  return messages
}

export const drawingByTongyi = async (option: CommonDrawingOption) => {
  const {
    apiKey,
    sessionId,
    prompt,
    negativePrompt,
    model,
    size,
    style,
    imageGenerated,
    end,
    abortCtr
  } = option

  // 提交生成图片任务
  fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis', {
    signal: abortCtr?.signal,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable'
    },
    body: JSON.stringify({
      model,
      input: {
        prompt: prompt,
        negative_prompt: negativePrompt
      },
      parameters: {
        style: style,
        size: size?.replace('x', '*'),
        n: 1
      }
    })
  })
    .then((res) => res.json())
    .then((respJson) => {
      // 获取任务id
      const taskId = respJson?.output?.task_id
      const errMsg = respJson?.message
      if (!taskId) {
        end && end(sessionId, errMsg)
        return
      }

      // 轮询任务结果
      const interval = setInterval(() => {
        fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
          signal: abortCtr?.signal,
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`
          }
        })
          .then((res) => res.json())
          .then((respJson) => {
            const taskStatus = respJson?.output?.task_status
            // 非正常任务状态，直接停止轮询并报错
            if (!['PENDING', 'RUNNING', 'SUCCEEDED'].includes(taskStatus)) {
              clearInterval(interval)
              end && end(sessionId, 'task error')
              return
            }
            // 成功任务状态，获取结果中的图片地址，保存本地并返回
            if (taskStatus === 'SUCCEEDED') {
              clearInterval(interval)
              const imageUrl = respJson?.output?.results[0].url ?? ''
              if (imageUrl) {
                saveFileByUrl(imageUrl, `${randomUUID()}.png`).then((localPath) => {
                  imageGenerated && imageGenerated(sessionId, localPath)
                  end && end(sessionId)
                })
              } else {
                end && end(sessionId)
              }
            }
          })
          .catch(() => {
            clearInterval(interval)
          })
      }, 3000)
    })
    .catch((err) => {
      Logger.error('drawingByTongyi error', err)
      end && end(sessionId, err)
    })
}
