/**
 * 假 OneBot v11 HTTP API 服务端 —— 只监听 127.0.0.1，绝不外发
 */
import http from 'node:http';

export async function 启动假OneBot({ token = '', 登录信息 = { user_id: 10001, nickname: '深鲸测试号' } } = {}) {
  const 收到 = [];
  const 失败动作 = new Set();
  const 服务 = http.createServer((req, res) => {
    let 体 = '';
    req.on('data', (块) => { 体 += 块; });
    req.on('end', () => {
      const 路径 = new URL(req.url || '/', 'http://local').pathname;
      const 动作 = 路径.replace(/^\/+/, '');
      const 记录 = { 动作, 头: req.headers, 体: 体 ? JSON.parse(体) : {} };
      收到.push(记录);

      if (token !== '') {
        const 授权 = String(req.headers.authorization || '');
        if (授权 !== 'Bearer ' + token) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'failed', retcode: 1403, message: 'token 不对' }));
          return;
        }
      }
      if (失败动作.has(动作)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'failed', retcode: 1200, message: '模拟失败' }));
        return;
      }
      if (动作 === 'get_login_info') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: 登录信息 }));
        return;
      }
      if (动作 === 'send_private_msg' || 动作 === 'send_group_msg') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 9001 } }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'failed', retcode: 1404, message: '未知动作' }));
    });
  });
  await new Promise((完成) => 服务.listen(0, '127.0.0.1', 完成));
  const 端口 = 服务.address().port;
  return {
    地址: 'http://127.0.0.1:' + 端口,
    收到,
    失败动作,
    关闭: () => new Promise((完成) => 服务.close(完成)),
  };
}
