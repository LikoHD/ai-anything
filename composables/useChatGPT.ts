import { STORAGE_KEY_GPT_SETTINGS } from "~/constants";
import { OpenAIMessages, ChatGPTOptions } from "~~/types";
import { convertOpenAIMessagesToAzurePrompt } from "~~/utils/azure";
import { createParser } from "eventsource-parser";
import { streamAsyncIterator } from "~~/utils";

export const defaultChatGPTOptions: ChatGPTOptions = {
  apiKey: "",
  apiBaseUrl: "https://api.openai.com",
  apiUrlPath: "/v1/chat/completions",
  provider: "OpenAI",
  model: "gpt-3.5-turbo",
  temperature: 1,
  top_p: 1,
  n: 1,
  stream: true,
  max_tokens: 1000,
  presence_penalty: 0,
  frequency_penalty: 0,
};

function createFetchGPTResponse(
  options: ChatGPTOptions,
  messages: OpenAIMessages,
  signal?: AbortSignal
) {
  const { apiKey, apiBaseUrl, apiUrlPath, provider, ...opts } = options;

  const body: Record<string, any> = {
    ...opts,
  };
  const headers: Record<string, any> = {
    "Content-Type": "application/json",
  };
  let url = apiUrlPath;
  switch (provider) {
    case "OpenAI":
      headers["Authorization"] = `Bearer ${apiKey}`;
      body["messages"] = messages;
      break;
    case "Azure":
      headers["api-key"] = `${apiKey}`;
      url = `${apiUrlPath}/${options.model}/completions?api-version=2022-12-01`;
      Object.assign(body, convertOpenAIMessagesToAzurePrompt(messages));
      break;
  }

  return $fetch.raw(url, {
    baseURL: apiBaseUrl,
    headers,
    body,
    method: "post",
    responseType: "stream",
    signal,
  });
}

export interface SendMessageOptions {
  messages: OpenAIMessages;
  gptOptions?: Partial<ChatGPTOptions>;
  onProgress?: (data: string) => void;
  signal?: AbortSignal;
}

export const useChatGPT = createSharedComposable(() => {
  const storageOptions = useLocalStorage(
    STORAGE_KEY_GPT_SETTINGS,
    defaultChatGPTOptions
  );
  const sendMessage = async (userOptions: SendMessageOptions) => {
    const options = {
      ...storageOptions.value,
      ...userOptions.gptOptions,
    };
    const { onProgress = () => {}, messages, signal } = userOptions;
    const resp = await createFetchGPTResponse(options, messages, signal);
    const parser = createParser((event) => {
      if (event.type === "event") {
        let data: Record<string, any>;
        try {
          data = JSON.parse(event.data);
        } catch {
          console.log("Failed to parse event data", event.data);
          return;
        }
        const { choices } = data;
        if (!choices || choices.length === 0) {
          throw new Error(`No choices found in response`);
        }
        let message = "";
        switch (options.provider) {
          case "OpenAI":
            const { content = "" } = choices[0].delta;
            message = content;
            break;
          case "Azure":
            message = choices[0].text;
            break;
        }
        onProgress(message);
      }
    });
    for await (const chunk of streamAsyncIterator[Symbol.asyncIterator](
      resp.body
    )) {
      const str = new TextDecoder().decode(chunk);
      parser.feed(str);
    }
  };
  return { sendMessage, storageOptions };
});
