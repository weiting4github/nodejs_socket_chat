
var config     = require('./config.js');
var app        = require('express')();
var http       = require("http").createServer(app);
var mysql      = require('mysql');
var url        = require('url');
var fs         = require('fs');
var io         = require('socket.io')(http, {'serveClient': false,
                                             'pingInterval': 20000, 
                                             'pingTimeout': 10000,
                                             'reconnection': false}); // 加入 Socket.IO
var bodyParser = require('body-parser');
var morgan     = require('morgan');
var jwt        = require('jsonwebtoken');
var sprintf    = require('sprintf-js').sprintf;
var crypto     = require('crypto');

var admin = require("firebase-admin");

var serviceAccount = require("./easyrelax-d6a3e-firebase-adminsdk-shpl3-eaa82e951c.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://easyrelax-d6a3e.firebaseio.com"
});

// mysql...
var pool;
handleDisconnect();
var paramUno;

var clients    = {};
var subClients = {};

var notes = [];

// for notification...
var uNickname = '';
var uImg = '';

if (pool.state === 'disconnected') {
  pool.connect(function(error, con) {
    if (error) {
      console.log(error);
      return;
    }
  });//end of 'pool connect'
}


http.listen(3000, function() {
  // console.log('server listen on 3000');
  app.set('secret', config.secret);
});

// 套用 middleware
app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());
app.use(morgan('dev'));

// router... 這邊改用歷史紀錄
app.get('/msgHistroy/:fno', function(request, response) {
  //console.log(request);

  let fno = request.params.fno;

  if (!request.headers.authorization || request.headers.authorization.length == 0) {

    response.json({ s: '-1', errorCode: '1', errorMsg: 'Failed to authenticate token.'});
    return; // 會跳到main繼續執行 後方不要再放會執行的程式
    
  }

  let token = request.headers.authorization.substring(6).trim();

  if (token) {
    // response.writeHead(200, { "Content-Type": "text/html" });
    jwt.verify(token, app.get('secret'), function(err, decode) {
      // jwt 認證失敗...
      if (err) {
        response.json({ s: '-1', errorCode: '2', errorMsg: 'Failed to authenticate token.'});
        return;
      }

      app.set('uno', decode.uno);

      if (fno == decode.uno) {
        console.log(fno);
        response.json({ "s": -1, "errorCode": 3, "errorMsg": "參數有誤" });
        return;
      }

      // 檢查是否有給清未讀參數
      if (request.query.hasOwnProperty('read_ts')) {
        // 更新已讀時間
        let read_ts = request.query.read_ts; 

        // 更新自己已讀
        let sql = sprintf("UPDATE `msg_group`.`%s` SET `owner_read_ts` = %d WHERE `owner_no` = %d AND `friend_no` = %d", 'msg_list_' + (app.get('uno') % 100), read_ts, app.get('uno'), fno);

        pool.query(sql, function (err, rows, fields) {
          if (err) {
            console.log(err);
            response.json({ "s": -1, "errorCode": 4, "errorMsg": "參數有誤" });
            return;
          }
        });


        // 更新對方自己的已讀
        sql = sprintf("UPDATE `msg_group`.`%s` SET `friend_read_ts` = %d WHERE `owner_no` = %d AND `friend_no` = %d", 'msg_list_' + (fno % 100), read_ts, fno, app.get('uno'));

        pool.query(sql, function (err, rows, fields) {
          if (err) {
            console.log(err);
            response.json({ "s": -1, "errorCode": 5, "errorMsg": "參數有誤" });
            return;
          }
        });
      }

      // 歷史訊息的sql...
      let ts = request.query.ts; // ts = 1509605901;
      let size = request.query.size; // size = 20;
      let sql = sprintf("SELECT * FROM `%s` WHERE `owner_no` = %d AND %d IN (`sender_no`, `receiver_no`) AND %d IN (`sender_no`, `receiver_no`) AND`ts` < %d AND `msg_status` = 1 ORDER BY `ts` DESC LIMIT %d", 'msg_detail_' + (decode.uno % 100), decode.uno, decode.uno, fno, ts, parseInt(size) + 1); //多取一筆判斷

      pool.query(sql, function (err, rows, fields) {

        if (err) {
          console.log(err);
          response.json({ "s": -1, "errorCode": 6, "errorMsg": err });
          return;
        } else {
          rows = (rows.length == 0) ? [] : rows;

          let next = ( rows.length == (parseInt(size) + 1) ) ? true : false; // 是否有下一頁紀錄
          let _rows = [];
          let currDate = new Date(ts * 1000);

          rows.forEach(function(e, i) {
            let msgDate = new Date(e.ts * 1000);

            // console.log(currDate.toLocaleDateString());
            // console.log(msgDate.toLocaleDateString());

            if (currDate.toLocaleDateString() !== msgDate.toLocaleDateString()) {
              // console.log(e);

              let emptyTs = new Date(msgDate.toLocaleDateString()).getTime();

              let emptyRow = {
                "msg": "",
                "msg_id": "",
                "msg_status": "",
                "msg_type": 2,
                "owner_no": "",
                "receiver_no": "",
                "sender_no": "",
                "ts": emptyTs / 1000
              }
              _rows.push(emptyRow);
              currDate = msgDate
            }
            _rows.push(e);

          });

          response.json({ "s": 1, "next" : next, "d": _rows });
          //console.log(JSON.stringify({ "s": 1, "next": next, "d": _rows }));
        }
      });
    });
  } else {
    response.status(200);
    response.send({
      s: '-1',
      message: 'No token provided.'
    });
    response.end();
    return;
  }




});

// app.get('/heartbeat/:uno', function(request, response) {
//   response.json({s: '1', errorCode: '2' , errorMsg: 'heartbeat good'});
// });













// ================
// global連線成功...
// ================

io.sockets.on('connection', function(socket) {
  // console.log(io);
  // global.socketID = socket.id;

  clients[socket.id] = socket;

  if (!socket.handshake.query.Authorization || socket.handshake.query.Authorization.length == 0) {
    socket.disconnect(true);
    return;
  }

  paramUno = socket.handshake.query.u;

  var token = socket.handshake.query.Authorization.substr(6).trim();
  console.log('main socket conneted id is:: ' + socket.id);

  jwt.verify(token, app.get('secret'), function(err, decode) {

    // 驗證是否是本人連線
    if ( err || (paramUno != decode.uno) ) {
      console.log(err);
      console.log('paramUno != decode.uno');
      socket.disconnect(true);
    }

    app.set('uno', decode.uno);
  });


  var uno = app.get('uno');
  var ns  = '/'+uno;

  if (ns == undefined) {
    console.log("====== undefined ======");
    socket.disconnect(true);
    return;
  }

  let nsp = io.of(ns);
  // console.log(io);

  nsp.once('connection', function(nsSocket) {
    subClients[nsSocket.id] = nsSocket;
    // console.log(nsSocket);

    nsSocket.emit('welcome', {welcome: 'Welcom xxx to this server'});

    nsSocket.on('history message', function(data) {
      // var ts   = data.ts;
      // var size = data.size;
      // var sql = sprintf("SELECT * FROM `%s` WHERE `ts` < %d LIMIT %d", 'msg_detail_'+(app.get('uno')%100), ts, size);

 
      // nsSocket.emit('history message', {"s":1,"d":[{"ts":1505113575,"owner_no":1,"sender_no":81,"receiver_no":1,"msg":"測試測試","msg_type":1,"msg_status":1,"msg_id":"bc689275be34f0d9d29d05e4c381a2bc"},{"ts":1505113584,"owner_no":1,"sender_no":81,"receiver_no":1,"msg":"麻煩欸","msg_type":1,"msg_status":1,"msg_id":"ca90a41deecc3b5ea386249c5a6da618"}]});

      // pool.query(sql, function(err, rows, fields) {
        
      //   if (err) {
      //     console.log(err);
      //     return;
      //   } else {
      //     rows = (rows.length == 0) ? [] : rows;
      //     console.log(JSON.stringify({"s": 1, "d": rows}));
      //     nsSocket.emit('history message', {"s": 1, "d": rows});
          
      //   }
      // });

    });

    // 傳送訊息...
    nsSocket.on('new message', function(data) {
      console.log(data);
      // 參數undefind錯誤 暫時補洞 不會真的發送出去...
      if (!data.receiver) {
        nsSocket.emit('new message', { "s": 1, "msg_id": "", "ts": data.ts });
        return;
      }

      let sql = sprintf("SELECT `device_token` FROM `easyrelax`.`user_device_token` WHERE `user_no` = %d", data.receiver);

      var registrationToken = null;

      pool.query(sql, function(err, rows, fields){
         
        if (err) {
          console.log(err);
          return;
        } else {
          rows = (rows.length == 0) ? [] : rows            
          for (let i in rows) {
            registrationToken = rows[i].device_token; //console.log(registrationToken);
            let sql = sprintf("SELECT * FROM `easyrelax`.`user_index` WHERE `user_no` = %d", app.get('uno'));
            
            pool.query(sql, function(err, rows, fields) {
              
              if (err) {
                console.log(err);
                return;
              } else {
                
                var uNickname = (typeof rows[0].user_nickname !== "undefined") ? rows[0].user_nickname : '';
                var uImg = (typeof rows[0].user_photo !== "undefined") ? 'https://s3-ap-northeast-1.amazonaws.com/img2easyrelax' + rows[0].user_photo : '';

                if (registrationToken !== null) {

                  let payload = {
                    data: {
                      no: app.get('uno'),
                      msg: data.msg,
                      type: "2",
                      nickname: uNickname,
                      ts: data.ts,
                      img: uImg,
                      target: "0"
                    }
                  };

                  // console.log(registrationToken);
                  console.log(payload);

                  admin.messaging().sendToDevice(registrationToken, payload)
                    .then(function (response) {
                      // See the MessagingDevicesResponse reference documentation for
                      // the contents of response.
                      console.log("Successfully sent message:", response);
                    })
                    .catch(function (error) {
                      console.log("Error sending message:", error);
                    });
                }

              } // end else
            }); // end sql
            
          } // end for
        }
      });
        
      

      // {"layout_type":0,"msg_data":"測測","msg_extradata":"","msg_state":0,"msg_type":0,"sender":"1","target_id":"81","ts":"1507772211"}
      var receiver = data.receiver;
      var msg      = data.msg;
      var ts       = data.ts;
      var msgId    = crypto.createHash('md5').update(receiver.toString()+ts.toString()).digest('hex');
      var shaCode  = crypto.createHash('sha256').update(msgId+"3345678").digest('hex');

      // 寫進自己的表
      sql = sprintf("INSERT IGNORE INTO `%s`(`ts`, `owner_no`, `sender_no`, `receiver_no`, `msg`, `msg_type`, `msg_id`) VALUES(%d, %d, %d, %d, '%s', 1, '%s')", 'msg_detail_'+(app.get('uno')%100), Math.round(new Date().getTime()/1000.0), app.get('uno'), app.get('uno'), receiver, msg, msgId);

      pool.query(sql, function(err, result) {
        if (err) {
          console.log(err);
          return;
        } else {
          // 更新最後一條訊息
          if (result.affectedRows == 1) {
            sql = sprintf("INSERT INTO `msg_group`.`%s` (`owner_no`, `friend_no`, `lastmsg_id`) VALUES (%d, %d, '%s') ON DUPLICATE KEY UPDATE `lastmsg_id` = '%s', `owner_read_ts` = %d, `status` = 1", 'msg_list_'+(app.get('uno')%100), app.get('uno'), receiver, msgId, msgId, Math.round(new Date().getTime()/1000.0));
            pool.query(sql);
          }
        }
      });

      // 寫進對方的表
      sql = sprintf("INSERT IGNORE INTO `%s`(`ts`, `owner_no`, `sender_no`, `receiver_no`, `msg`, `msg_type`, `msg_id`) VALUES(%d, %d, %d, %d, '%s', 1, '%s')", 'msg_detail_'+receiver, Math.round(new Date().getTime()/1000.0), receiver, app.get('uno'), receiver, msg, msgId);

      pool.query(sql, function(err, result) {
        if (err) {
          console.log(err);
        } else {
          // 寫入成功在更新最後一筆訊息
          if (result.affectedRows == 1) { 
            sql = sprintf("INSERT INTO `msg_group`.`%s` (`owner_no`, `friend_no`, `lastmsg_id`) VALUES (%d, %d, '%s') ON DUPLICATE KEY UPDATE `lastmsg_id` = '%s', `friend_read_ts` = %d, `status` = 1", 'msg_list_'+receiver, receiver, app.get('uno'), msgId, msgId, Math.round(new Date().getTime()/1000.0));
            pool.query(sql);
          }
        }
      });

      // 這裡用socket傳送
      if (io.nsps["/"+receiver]) {
        io.of("/"+receiver).emit('new received', {"s": 1, "msg": msg, "msg_id": msgId, "code": shaCode});
      }

      // 回傳狀態給手機
      nsSocket.emit('new message', {"s": 1, "msg_id": msgId, "ts": ts});
    });

    nsSocket.on('disconnect', function(reason) {
      // console.log(io);
      console.log('=========nsSocket on disconnect..' + nsSocket.id + 'reason:: ' +reason + '======');
      // io.sockets.remove(nsSocket);
      // delete subClients[nsSocket.id];
    });

    nsSocket.on('ping', () => {
      console.log("===========i am ping");
    });

    nsSocket.on('pong', (latency) => {
      console.log("============i am pong :: " + latency);
    });

  });

  socket.on('disconnect', function(reason) {
    console.log('=========socket on disconnect..' + socket.id + 'reason:: ' +reason + '======');
    io.sockets.remove(socket);
    delete clients[socket.id];
    delete nsp;
  });


}); // end of "socket on connection"



function testPage(response) {
  // for test self
  var path = '/socket.html';
  
    fs.readFile(__dirname + path, function(error, data) {
      if (error){
        response.writeHead(404);
        response.write("opps this doesn't exist - 404");
      } else {
        response.writeHead(200, {"Content-Type": "text/html"});
        response.write(data, "utf8");
      }
      response.end();
    });
}

// 連線狀態監聽
function handleDisconnect() {

  pool = mysql.createConnection(config.database);

  pool.on('error', function(err) {
    console.log("DB get error::"+err.code);
    if(err.code === 'PROTOCOL_CONNECTION_LOST') { // Connection to the MySQL server is usually
      handleDisconnect();                         // lost due to either server restart, or a
      console.log('DB Reconnecting...');
    } else {                                      // connnection idle timeout (the wait_timeout
      throw err;                                  // server variable configures this)
    }
  });
}
