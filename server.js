/**
 * 极简图片生成代理服务
 *
 * 使用说明：
 * 1. 安装依赖: npm i express sharp  # 若 Node <18 需额外安装 node-fetch@^3
 * 2. 替换CONFIG对象中的硬编码值（从浏览器抓包获取）
 * 3. 运行: node server.js
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const sharp = require('sharp');
const dotenv = require('dotenv');


dotenv.config();
const CONFIG = process.env;   // ← 用环境变量

// 检查必填
['COOKIE','X_MS_TOKEN','DEVICE_ID','TEA_UUID','WEB_ID','MS_TOKEN','A_BOGUS','ROOM_ID']
  .forEach(k => { if (!CONFIG[k]) { console.error(`缺少 ${k}`); process.exit(1);} });

const BASE_URL = 'https://www.doubao.com';

// Node 18+ 自带 fetch；若当前环境无，则动态加载 node-fetch@3
let fetch = global.fetch;
if (!fetch) {
  const nodeFetch = require('node-fetch');
  fetch = nodeFetch;
}

const app = express();
const PORT = process.env.PORT || 3000;

// 确保 public 目录存在，用于存放 pic.png
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

// 静态托管根目录（index.html 等）与 public 目录（生成图片）
app.use(express.static(__dirname));
app.use(express.static(publicDir));
app.use(express.json());

// 基础URL和必备参数
const getQueryParams = () => {
  return `aid=497858&device_id=${CONFIG.DEVICE_ID}&device_platform=web&language=zh&pc_version=2.16.7&pkg_type=release_version&real_aid=497858&region=CN&samantha_web=1&sys_region=CN&tea_uuid=${CONFIG.TEA_UUID}&use-olympus-account=1&version_code=20800&web_id=${CONFIG.WEB_ID}&msToken=${CONFIG.MS_TOKEN}&a_bogus=${CONFIG.A_BOGUS}`;
};

// 通用请求头
const getHeaders = () => {
  return {
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    'agw-js-conv': 'str',
    'cookie': CONFIG.COOKIE,
    'x-ms-token': CONFIG.X_MS_TOKEN,
    'origin': BASE_URL,
    'referer': `${BASE_URL}/chat/${CONFIG.ROOM_ID}`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
  };
};

app.post('/generate', async (req, res) => {
  try {
    const prompt = (req.body && req.body.text) || '';
    if (!prompt) return res.status(400).json({ error: '提示词不能为空' });

    console.log(`正在生成图片，提示词: "${prompt}"`);
    console.log(`请求头: ${JSON.stringify(req.headers)}`);
    console.log(`请求体: ${JSON.stringify(req.body)}`);

    // 1. 调用生成接口，处理SSE流
    const result = await generateImage(prompt);
    
    if (!result.imageUrl) {
      return res.status(500).json({ error: '未能获取到图片URL' });
    }

    // 如果有多张图片URL，直接返回给前端
    if (result.allImageUrls && result.allImageUrls.length > 0) {
      console.log(`找到 ${result.allImageUrls.length} 张图片，直接返回URL给前端`);
      return res.json({ 
        urls: result.allImageUrls,
        url: result.imageUrl // 兼容旧版
      });
    }

    // 2. 下载图片并转换
    const pngPath = await downloadAndConvertImage(result.imageUrl);
    
    // 3. 返回本地图片路径
    res.json({ url: '/pic.png' });
  } catch (err) {
    console.error('图片生成失败:', err);
    console.error('错误详情:', err.stack);
    console.error('错误类型:', err.name);
    console.error('错误消息:', err.message);
    
    // 返回更详细的错误信息给客户端
    res.status(500).json({ 
      error: err.message || '服务器错误',
      errorType: err.name,
      errorStack: process.env.NODE_ENV !== 'production' ? err.stack : undefined
    });
  }
});

// 生成图片，解析SSE流
async function generateImage(promptText) {
  const url = `${BASE_URL}/samantha/chat/completion?${getQueryParams()}`;
  
  // 生成UUID作为本地消息ID
  const generateUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  };
  
  const localMsgId = generateUUID();
  const localConvId = `local_${Math.floor(Math.random() * 10000000000000000)}`;
  
  // 新的API请求格式
  const body = {
    completion_option: {
      is_regen: false,
      with_suggest: true,
      need_create_conversation: true,
      launch_stage: 1,
      reply_id: "0"
    },
    conversation_id: "0",
    local_conversation_id: localConvId,
    local_message_id: localMsgId,
    messages: [
      {
        content: JSON.stringify({text: promptText}),
        content_type: 2001,
        attachments: [],
        references: []
      }
    ]
  };

  console.log('发送请求到生成接口...');
  console.log(`请求URL: ${url}`);
  console.log(`请求体: ${JSON.stringify(body)}`);
  
  try {
    const controller = new AbortController();
    const response = await fetch(url, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal
    });

    console.log(`响应状态: ${response.status} ${response.statusText}`);
    console.log(`响应头: ${JSON.stringify([...response.headers.entries()])}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`请求失败详情: ${errorText}`);
      throw new Error(`生成请求失败: ${response.status} ${response.statusText}, 详情: ${errorText}`);
    }

    if (!response.body) {
      throw new Error('生成请求返回异常: 无响应体');
    }

    console.log('开始处理SSE流...');
    
    // 全局变量，用于保存最终的图片URL
    let imageUrl = null;
    let nodeId = null;
    // 保存所有找到的图片URL
    const allImageUrls = [];
    // 保存最终结果，解决abort导致的问题
    let finalResult = null;

    // 新的 SSE 处理函数
    async function handleSSE(stream, onImage) {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        
        // 检查是否是网关错误
        if (buffer.includes('event: gateway-error')) {
          const errorMatch = buffer.match(/data:\s*({.*})/);
          if (errorMatch && errorMatch[1]) {
            try {
              const errorData = JSON.parse(errorMatch[1]);
              console.error('服务器网关错误:', errorData);
              throw new Error(`服务器返回网关错误: ${errorData.code} - ${errorData.message}`);
            } catch (e) {
              throw new Error(`服务器返回网关错误: ${buffer}`);
            }
          } else {
            throw new Error(`服务器返回网关错误: ${buffer}`);
          }
        }

        // 根据 "\n\n" 拆成完整 event；最后一个可能是半截，留给下轮补全
        const events = buffer.split('\n\n');
        buffer = events.pop();          // 保留最后可能不完整的部分

        for (const evt of events) {
          const line = evt.trim().split('\n')          // 每行 "event: xxx" / "data: xxx"
                         .find(l => l.startsWith('data: '));
          if (!line) continue;

          try {
            const evtObj = JSON.parse(line.slice(6));             // 外层
            console.log(`解析到事件: type=${evtObj.event_type || 'unknown'}`);
            
            // 保存node_id备用
            if (evtObj.event_type === 2001) {
              try {
                const inner = JSON.parse(evtObj.event_data);         // event_data
                if (!nodeId && inner.node_id) {
                  nodeId = inner.node_id;
                  console.log('保存node_id:', nodeId);
                }
                
                const msg = inner.message;
                if (!nodeId && msg?.id) {
                  nodeId = msg.id;
                  console.log('保存真正的node_id (message.id):', nodeId);
                }
                
                // 只处理图片消息
                if (msg?.content_type === 2074) {
                  console.log('找到图片载体消息 (content_type 2074)');
                  const content = JSON.parse(msg.content);               // creations 数组
                  
                  console.log(`找到 ${content.creations?.length || 0} 张图片信息，状态:`, 
                    content.creations?.map(c => c.image?.status || 'unknown').join(', '));
                  
                  let foundStatus2 = false;
                  for (const creation of content.creations || []) {
                    // 只处理status为2的完成图片
                    if (creation?.image?.status === 2) {
                      const url = creation.image.image_ori?.url || 
                                 creation.image.image_raw?.url || 
                                 creation.image.image_thumb?.url;
                      
                      if (url) {
                        console.log(`✅ 找到图片真实URL (status=2):`, url);
                        foundStatus2 = true;
                        onImage(url);
                      }
                    }
                  }
                  
                  // 如果找到了完成的图片，可以提前结束
                  if (foundStatus2) {
                    console.log('找到有效图片，可以提前结束处理');
                    return;
                  }
                } 
                // 常规进度报告
                else if (inner.step) {
                  console.log(`生成进度: ${Math.round(inner.step * 100)}%`);
                }
              } catch (e) {
                console.error('解析内层事件数据失败:', e);
              }
            }
            // event_type 2003表示流结束
            else if (evtObj.event_type === 2003) {
              console.log('收到流结束事件 (2003)');
              return;
            }
          } catch (e) { 
            console.log('解析事件失败（可能是不完整的JSON）:', e.message);
          }
        }
      }
    }

    try {
      // 使用新的 SSE 处理函数
      await handleSSE(response.body, (url) => {
        allImageUrls.push(url);
        // 只保存第一张作为主图
        if (!imageUrl) {
          imageUrl = url;
          finalResult = { imageUrl, allImageUrls };
        }
      });
      
      // 如果有最终结果，直接返回
      if (finalResult) {
        console.log(`✅ 共找到 ${allImageUrls.length} 张有效图片，将使用第一张`);
        return finalResult;
      }
    } catch (err) {
      console.error('处理SSE流失败:', err);
      if (allImageUrls.length > 0) {
        // 如果已有图片URL，仍然可以返回
        console.log('尽管出错，但已找到图片URL，继续处理');
        return { imageUrl, allImageUrls };
      }
      throw err;
    }

    // 若SSE流中没获取到图片，尝试轮询获取
    if (!imageUrl && nodeId) {
      console.log(`SSE流中未找到图片URL，使用node_id进行轮询: ${nodeId}`);
      const result = await pollImageResult(nodeId);
      return result;
    }

    return { imageUrl, allImageUrls }; // 兼容原逻辑
  } catch (err) {
    console.error('图片生成请求失败:', err);
    throw err;
  }
}

// 轮询获取图片结果
async function pollImageResult(nodeId, maxRetries = 5) {
  const url = `${BASE_URL}/samantha/aispace/message_node_info?${getQueryParams()}`;
  const body = { node_id: nodeId };
  
  console.log('开始轮询图片结果...');
  console.log(`轮询URL: ${url}`);
  console.log(`轮询请求体: ${JSON.stringify(body)}`);
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`轮询尝试 ${i+1}/${maxRetries}...`);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(body)
      });

      console.log(`轮询响应状态: ${response.status} ${response.statusText}`);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`轮询失败详情: ${errorText}`);
        console.error(`轮询请求失败: ${response.status}, 详情: ${errorText}`);
        continue;
      }

      const data = await response.json();
      console.log(`轮询响应数据片段: ${JSON.stringify(data).substring(0, 200)}...`);
      
      if (data.code !== 0) {
        console.error(`API返回错误码: ${data.code}, ${data.msg}`);
        continue;
      }

      // 处理新版API结构 (2074 content_type)
      if (data.data && data.data.messages && data.data.messages[0]) {
        const msg = data.data.messages[0];
        if (msg.content_type === 2074 && msg.content) {
          try {
            const payload = JSON.parse(msg.content);
            if (payload.creations && payload.creations.length > 0) {
              // 寻找status为2的所有图片
              const allImageUrls = [];
              let imageUrl = null;
              
              payload.creations.forEach((creation, index) => {
                // 只处理status为2的完成图片
                if (creation.image && creation.image.status === 2) {
                  const url = creation.image.image_ori?.url || 
                              creation.image.image_raw?.url || 
                              creation.image.image_thumb?.url;
                  
                  if (url) {
                    console.log(`轮询找到第${index+1}张有效图片URL (status=2): ${url}`);
                    allImageUrls.push(url);
                    
                    // 第一张作为主图
                    if (!imageUrl) {
                      imageUrl = url;
                    }
                  }
                } else if (creation.image) {
                  console.log(`轮询中图片 ${index+1} 状态为 ${creation.image.status || 'unknown'}，跳过...`);
                }
              });
              
              if (allImageUrls.length > 0) {
                console.log(`轮询共找到 ${allImageUrls.length} 张有效图片URL`);
                return { imageUrl, allImageUrls };
              }
              
              console.log('轮询到的图片都不是status=2的状态，继续等待...');
            }
          } catch (e) {
            console.error('解析2074消息内容失败:', e);
          }
        }
      }

      // 检查其他可能的路径获取图片URL (旧版兼容)
      let imageUrl = null;
      
      // 尝试不同的路径获取图片URL
      if (data.data.elements && data.data.elements[0] && data.data.elements[0].type === 'image') {
        imageUrl = data.data.elements[0].url;
        console.log('轮询通过elements路径找到图片URL');
      } else if (data.data.message?.elements && data.data.message.elements[0] && data.data.message.elements[0].type === 'image') {
        imageUrl = data.data.message.elements[0].url;
        console.log('轮询通过message.elements路径找到图片URL');
      } else if (data.data.messages && data.data.messages[0] && data.data.messages[0].attachments) {
        const attach = data.data.messages[0].attachments[0];
        if (attach && attach.type === 'image' && attach.url) {
          imageUrl = attach.url;
          console.log('轮询通过messages[0].attachments路径找到图片URL');
        }
      }
      
      if (imageUrl) {
        return { imageUrl, allImageUrls: [imageUrl] };
      }
      
      if (data.data.status === 'progress') {
        console.log('图片仍在生成中，等待下次轮询...');
      }
      
      // 等待1.5秒后继续轮询
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (err) {
      console.error('轮询过程出错:', err);
      console.error('错误详情:', err.stack);
    }
  }
  
  throw new Error('轮询超过最大次数，未能获取图片');
}

// 下载图片并转换为PNG
async function downloadAndConvertImage(imageUrl) {
  console.log('开始下载图片...');
  console.log(`图片URL: ${imageUrl}`);
  
  try {
    const imgResp = await fetch(imageUrl);
    console.log(`图片下载响应状态: ${imgResp.status} ${imgResp.statusText}`);
    
    if (!imgResp.ok) {
      const errorText = await imgResp.text();
      console.error(`图片下载失败详情: ${errorText}`);
      throw new Error(`下载图片失败: ${imgResp.status}, 详情: ${errorText}`);
    }
    
    console.log('图片下载完成，准备转换为PNG...');
    
    const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
    console.log(`下载的图片大小: ${imgBuffer.length} 字节`);
    const pngPath = path.join(publicDir, 'pic.png');
    
    // 处理各种格式的图片，都转为PNG
    try {
      await sharp(imgBuffer).png().toFile(pngPath);
    } catch (err) {
      console.error('使用sharp转换图片失败:', err);
      
      // 如果sharp处理失败，可能是不支持的格式，直接保存原始文件
      console.log('尝试直接保存原始图片文件...');
      fs.writeFileSync(pngPath, imgBuffer);
    }
    
    console.log(`图片已保存到: ${pngPath}`);
    
    return pngPath;
  } catch (err) {
    console.error('图片下载或转换过程出错:', err);
    console.error('错误详情:', err.stack);
    throw err;
  }
}

app.listen(PORT, () => {
  console.log(`✨服务已启动，访问 http://localhost:${PORT}`);
  console.log('- 请确保 .env 文件包含所有必需参数');
  console.log('- 在浏览器打开上面的地址，输入提示词生成图片');
}); 