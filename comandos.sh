== config ==
proejto config/etomada@.service >
cat /etc/systemd/system/etomada@.service

== start/stop ==
systemctl daemon-reload # 1 vez so!
systemctl start etomada@dev
systemctl status etomada@dev

systemctl start etomada@prod

== acompanhar logs ==
journalctl -fu etomada@dev