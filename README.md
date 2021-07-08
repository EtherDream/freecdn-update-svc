# 简介

freecdn 更新推送服务。站点清单文件变化时，该服务通知在线用户重新加载清单。[查看说明](https://github.com/EtherDream/freecdn/blob/master/docs/feature/readme.md#%E8%B5%84%E6%BA%90%E5%BF%AB%E9%80%9F%E6%9B%B4%E6%96%B0)


# 安装

```bash
npm install freecdn-update-svc -g
```


# 启动

```bash
freecdn-update-svc
```

该服务无需配置。当用户加入时，程序根据 Origin 请求头将相应的站点加入观察名单；当某站点所有用户都离开时，程序停止观察该站点。


# 使用案例

https://github.com/EtherDream/freecdn/tree/master/examples/quick-update


# 公共服务

* wss://freecdn1.etherdream.com:30000

* wss://freecdn2.etherdream.com:30000


# 检测间隔

服务默认每隔 60s 检测所有站点清单是否更新，可通过 timer 参数调整间隔，例如设置成 20s：

```bash
freecdn-update-svc --timer 20
```

访问服务 `/update?site=$origin` 接口，可立即检测某站点，从而加快更新生效时间：

```bash
curl https://freecdn1.etherdream.com:30000/update?site=https://foo.com
```

该接口每个间隔期间只能访问一次，防止过度请求。


# 通信协议

该服务使用 WebSocket 和用户保持长连接。

协议非常简单，客户端无需发送任何数据。推送更新时，服务端发送清单 SHA-256 即可（32 字节的二进制数据）。


# 功能扩展

该服务未提供黑名单、限流、日志等功能，建议放在已有的 Web 服务器后面运行，从而可复用功能和策略。例如通过 nginx 反向代理：

```conf
server {
  listen                      443 ssl http2;
  # ...

  location = /update {
    proxy_pass                http://unix:/tmp/freecdn.sock;
    # auth ...
  }

  location = / {
    proxy_pass                http://unix:/tmp/freecdn.sock;
    proxy_set_header          x-client-addr   $remote_addr:$remote_port;
    proxy_set_header          connection      upgrade;
    proxy_set_header          upgrade         $http_upgrade;
    proxy_http_version        1.1;
  }
}
```

开启服务：

```bash
freecdn-update-svc -s /tmp/freecdn.sock
```

通过这种方式，你还可以设置 `/update` 接口访问权限，增加认证等功能。


# 开发测试

使用 TypeScript 开发，执行 `tsc` 编译或 `tsc -w` 调试。