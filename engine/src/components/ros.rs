use std::io;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const MASTER_ADDRESS: &str = "127.0.0.1:11311";
const CALLER_ID: &str = "/alfred_engine";

pub struct RosTopic {
    pub name: &'static str,
    pub publisher_node: &'static str,
    pub message_type: &'static str,
    pub md5: &'static str,
    pub max_frame_bytes: usize,
}

pub struct RosSubscriber;

impl RosSubscriber {
    pub async fn subscribe<F>(topic: &RosTopic, mut receive: F) -> Result<(), String>
    where
        F: FnMut(&[u8]) -> Result<(), String>,
    {
        let publisher_uri = lookup_node(topic.publisher_node).await?;
        let (host, port) = request_topic(&publisher_uri, topic.name).await?;
        let address = format!("{}:{}", normalize_host(&host), port);
        let mut stream = TcpStream::connect(&address)
            .await
            .map_err(|error| format!("cannot connect to ROS publisher {address}: {error}"))?;

        write_tcpros_header(&mut stream, topic).await?;
        read_frame(&mut stream, 64 * 1024).await?;

        loop {
            let payload = read_frame(&mut stream, topic.max_frame_bytes).await?;
            receive(&payload)?;
        }
    }
}

async fn lookup_node(node: &str) -> Result<String, String> {
    let body = method_call("lookupNode", &[string_param(CALLER_ID), string_param(node)]);
    let response = xmlrpc(MASTER_ADDRESS, &body).await?;
    strings(&response)
        .into_iter()
        .find(|value| value.starts_with("http://"))
        .ok_or_else(|| format!("ROS master returned no URI for {node}"))
}

async fn request_topic(publisher_uri: &str, topic: &str) -> Result<(String, u16), String> {
    let address = address_from_uri(publisher_uri)?;
    let protocols = "<param><value><array><data><value><array><data><value><string>TCPROS</string></value></data></array></value></data></array></value></param>";
    let body = format!(
        "<?xml version=\"1.0\"?><methodCall><methodName>requestTopic</methodName><params>{}{}{protocols}</params></methodCall>",
        string_param(CALLER_ID),
        string_param(topic),
    );
    let response = xmlrpc(&address, &body).await?;
    let host = strings(&response)
        .into_iter()
        .find(|value| value == "localhost" || value.parse::<std::net::IpAddr>().is_ok())
        .ok_or_else(|| "ROS publisher returned no TCPROS host".to_string())?;
    let port = integers(&response)
        .last()
        .copied()
        .and_then(|value| u16::try_from(value).ok())
        .ok_or_else(|| "ROS publisher returned no TCPROS port".to_string())?;
    Ok((host, port))
}

async fn xmlrpc(address: &str, body: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect(address)
        .await
        .map_err(|error| format!("cannot connect to ROS XML-RPC {address}: {error}"))?;
    let request = format!(
        "POST / HTTP/1.1\r\nHost: {address}\r\nContent-Type: text/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| format!("cannot write ROS XML-RPC request: {error}"))?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .map_err(|error| format!("cannot read ROS XML-RPC response: {error}"))?;
    let response = String::from_utf8_lossy(&response).into_owned();
    if !response.starts_with("HTTP/1.1 200") && !response.starts_with("HTTP/1.0 200") {
        return Err(format!(
            "ROS XML-RPC rejected request: {}",
            one_line(&response)
        ));
    }
    Ok(response)
}

async fn write_tcpros_header(stream: &mut TcpStream, topic: &RosTopic) -> Result<(), String> {
    let fields = [
        format!("callerid={CALLER_ID}"),
        format!("md5sum={}", topic.md5),
        format!("topic={}", topic.name),
        format!("type={}", topic.message_type),
        "tcp_nodelay=1".to_string(),
    ];
    let mut header = Vec::new();
    for field in fields {
        header.extend_from_slice(&(field.len() as u32).to_le_bytes());
        header.extend_from_slice(field.as_bytes());
    }
    stream
        .write_all(&(header.len() as u32).to_le_bytes())
        .await
        .map_err(io_string)?;
    stream.write_all(&header).await.map_err(io_string)
}

async fn read_frame(stream: &mut TcpStream, max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut length = [0_u8; 4];
    stream.read_exact(&mut length).await.map_err(io_string)?;
    let length = u32::from_le_bytes(length) as usize;
    if length > max_bytes {
        return Err(format!("ROS frame exceeds limit: {length}"));
    }
    let mut payload = vec![0_u8; length];
    stream.read_exact(&mut payload).await.map_err(io_string)?;
    Ok(payload)
}

fn method_call(name: &str, params: &[String]) -> String {
    format!(
        "<?xml version=\"1.0\"?><methodCall><methodName>{name}</methodName><params>{}</params></methodCall>",
        params.join("")
    )
}

fn string_param(value: &str) -> String {
    format!("<param><value><string>{value}</string></value></param>")
}

fn strings(xml: &str) -> Vec<String> {
    let mut values = tag_values(xml, "string");
    values.extend(
        tag_values(xml, "value")
            .into_iter()
            .filter(|value| !value.contains('<')),
    );
    values
}

fn integers(xml: &str) -> Vec<i64> {
    let mut values = tag_values(xml, "int");
    values.extend(tag_values(xml, "i4"));
    values
        .into_iter()
        .filter_map(|value| value.parse().ok())
        .collect()
}

fn tag_values(input: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut remainder = input;
    let mut values = Vec::new();
    while let Some(start) = remainder.find(&open) {
        let content = &remainder[start + open.len()..];
        let Some(end) = content.find(&close) else {
            break;
        };
        values.push(content[..end].to_string());
        remainder = &content[end + close.len()..];
    }
    values
}

fn address_from_uri(uri: &str) -> Result<String, String> {
    let authority = uri
        .strip_prefix("http://")
        .and_then(|value| value.split('/').next())
        .ok_or_else(|| format!("invalid ROS URI: {uri}"))?;
    if authority.contains(':') {
        Ok(authority.replace("localhost", "127.0.0.1"))
    } else {
        Ok(format!("{}:80", normalize_host(authority)))
    }
}

fn normalize_host(host: &str) -> &str {
    if host == "localhost" {
        "127.0.0.1"
    } else {
        host
    }
}

fn io_string(error: io::Error) -> String {
    error.to_string()
}

fn one_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}
