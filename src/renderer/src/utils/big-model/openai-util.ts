import OpenAI from 'openai'
import { readLocalImageBase64, saveFileByUrl } from '@renderer/utils/ipc-util'
import { randomUUID } from '@renderer/utils/id-util'
import { CommonChatOption } from '.'
import { ChatCompletionMessageParam } from 'openai/resources/chat'
import { limitContext, turnChat } from '@renderer/utils/big-model/base-util'
import { Logger } from '@renderer/utils/logger'

export const chat2openai = async (option: CommonChatOption) => {
  const {
    model,
    instruction,
    inputMaxTokens,
    contextSize,
    apiKey,
    baseURL,
    type,
    maxTokens,
    messages,
    imagePrompt,
    imageSize,
    imageQuality,
    imageStyle,
    sessionId,
    startAnswer,
    appendAnswer,
    imageGenerated,
    end
  } = option

  // OpenAI实例
  const openai = new OpenAI({
    apiKey,
    baseURL,
    dangerouslyAllowBrowser: true
  })

  // 对话或者绘画
  if (type === 'chat' && messages != null) {
    // OpenAI 对话
    const stream = await openai.chat.completions.create({
      messages: (await getOpenAIMessages(
        messages,
        instruction,
        inputMaxTokens,
        contextSize
      )) as ChatCompletionMessageParam[],
      model,
      stream: true,
      max_tokens: maxTokens
    })

    // 开始回答
    startAnswer && startAnswer(sessionId)

    // 连续回答
    for await (const chunk of stream) {
      Logger.info('chat2openai:', chunk)
      appendAnswer && appendAnswer(sessionId, chunk.choices[0].delta.content ?? '')
    }
  } else if (type === 'drawing' && imagePrompt != null) {
    // OpenAI 绘画
    const imagesResponse = await openai.images.generate({
      prompt: imagePrompt,
      model,
      size: imageSize as '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792' | null,
      response_format: 'url',
      quality: imageQuality as 'standard' | 'hd',
      style: imageStyle as 'vivid' | 'natural' | null
    })
    Logger.info('chat2openai:', imagesResponse)

    // 获取图片地址
    let imageUrl = imagesResponse.data[0].url ?? ''
    if (imageUrl) {
      // 保存图片
      imageUrl = await saveFileByUrl(imageUrl, `${randomUUID()}.png`)
    }

    // 返回图片本地地址
    imageGenerated && imageGenerated(sessionId, imageUrl)
  }

  // 结束
  end && end(sessionId)
}

export const getOpenAIMessages = async (
  chatMessageList: ChatMessage[],
  instruction: string,
  inputMaxTokens: number | undefined,
  contextSize: number
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

  // 转换消息结构
  const openaiMessages: ChatCompletionMessageParam[] = []
  for (const m of chatMessageList) {
    // 处理用户消息中的图片
    if (m.image && m.role === 'user') {
      const imageBase64Data = await readLocalImageBase64(m.image)
      openaiMessages.push({
        role: 'user',
        content: [
          { type: 'text', text: m.content },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpg;base64,${imageBase64Data}`
            }
          }
        ]
      })
    } else {
      openaiMessages.push({
        role: m.role,
        content: m.content
      })
    }
  }

  return openaiMessages
}
