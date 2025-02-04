import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import Chat from '../chat/Chat';
import { API_URL, SOCKET_CONFIG } from '../config';

const AdminStreamer = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [streamError, setStreamError] = useState('');
  const [messages, setMessages] = useState([]);
  const [viewerStats, setViewerStats] = useState({ count: 0, viewers: [] });
  const [isVideoEnabled, setIsVideoEnabled] = useState(false);
  const [isAudioEnabled, setIsAudioEnabled] = useState(false);
  const socketRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const peerConnectionsRef = useRef({});

  const toggleVideo = async () => {
    try {
      if (!streamRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 }
          },
          audio: isAudioEnabled
        });
        
        streamRef.current = stream;
        videoRef.current.srcObject = stream;
        setIsVideoEnabled(true);

        // Update all existing peer connections with the new stream
        Object.values(peerConnectionsRef.current).forEach(pc => {
          stream.getTracks().forEach(track => {
            pc.addTrack(track, stream);
          });
        });

        if (!socketRef.current) {
          initializeSocket();
        }
        socketRef.current.emit('stream:start');
      } else {
        const videoTrack = streamRef.current.getVideoTracks()[0];
        if (videoTrack) {
          videoTrack.enabled = !videoTrack.enabled;
          setIsVideoEnabled(videoTrack.enabled);
        }
      }
    } catch (error) {
      console.error('Error accessing camera:', error);
      alert('Failed to access camera. Please check permissions.');
    }
  };

  const toggleAudio = async () => {
    if (!streamRef.current) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: isVideoEnabled,
          audio: true
        });
        streamRef.current = stream;
        videoRef.current.srcObject = stream;
        setIsAudioEnabled(true);
        
        if (!socketRef.current) {
          initializeSocket();
        }
        socketRef.current.emit('stream:start');
      } catch (error) {
        console.error('Error accessing microphone:', error);
        alert('Failed to access microphone. Please check permissions.');
        return;
      }
    } else {
      const audioTrack = streamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsAudioEnabled(audioTrack.enabled);
      }
    }
  };

  useEffect(() => {
    if (!isAuthenticated) return; // Only connect if authenticated

    console.log('Initializing socket connection...');
    const socket = io(API_URL, {
      ...SOCKET_CONFIG,
      auth: { token: 'admin' }
    });

    socket.on('connect', () => {
      console.log('Connected to server with ID:', socket.id);
      if (streamRef.current) {
        console.log('Emitting stream:start on connect...');
        socket.emit('stream:start');
      }
    });

    socket.on('connect_error', (error) => {
      console.error('Socket connection error:', error);
      setStreamError('Failed to connect to server. Please try again.');
    });

    socket.on('disconnect', (reason) => {
      console.log('Disconnected from server:', reason);
    });

    // Handle chat messages
    socket.on('chat:message', (msg) => {
      setMessages(prev => {
        if (prev.some(m => m.id === msg.id)) return prev;
        return [...prev.slice(-99), msg];
      });
    });

    // Request chat history
    socket.emit('chat:history');
    socket.on('chat:history', (history) => {
      if (Array.isArray(history)) {
        setMessages(history);
      }
    });

    // Handle viewer offers
    socket.on('offer', async ({ offer, viewerId }) => {
      try {
        let pc = peerConnectionsRef.current[viewerId];
        if (!pc) {
          pc = new RTCPeerConnection({
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' }
            ]
          });
          peerConnectionsRef.current[viewerId] = pc;

          // Add local stream
          if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => {
              pc.addTrack(track, streamRef.current);
            });
          }

          pc.onicecandidate = (event) => {
            if (event.candidate) {
              socket.emit('ice-candidate', {
                candidate: event.candidate,
                targetId: viewerId
              });
            }
          };

          pc.onconnectionstatechange = () => {
            console.log(`Connection state for viewer ${viewerId}:`, pc.connectionState);
          };
        }

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit('answer', { answer, viewerId });
      } catch (error) {
        console.error('Error handling offer:', error);
      }
    });

    // Handle ICE candidates
    socket.on('ice-candidate', async ({ candidate, viewerId }) => {
      try {
        const pc = peerConnectionsRef.current[viewerId];
        if (pc) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
      } catch (error) {
        console.error('Error adding ICE candidate:', error);
      }
    });

    // Handle viewer stats
    socket.on('viewers:update', (stats) => {
      setViewerStats(stats);
    });

    // Store socket reference
    socketRef.current = socket;

    // Cleanup function
    return () => {
      console.log('Cleaning up socket connection...');
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => {
          console.log('Stopping track:', track.kind);
          track.stop();
        });
        streamRef.current = null;
      }
      
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }

      Object.values(peerConnectionsRef.current).forEach(pc => {
        pc.close();
      });
      peerConnectionsRef.current = {};
      
      if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
      }
    };
  }, [isAuthenticated]); // Only depend on isAuthenticated

  const handleLogin = async (e) => {
    e.preventDefault();
    if (username === 'admin' && password === '12345') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true
        });
        
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(err => console.error('Error playing video:', err));
        }
        
        setIsAuthenticated(true);
        setIsVideoEnabled(true);
        setIsAudioEnabled(true);
      } catch (error) {
        console.error('Error accessing media devices:', error);
        setStreamError('Failed to access camera/microphone');
      }
    } else {
      setStreamError('Invalid credentials');
    }
  };

  const handleSendMessage = (message) => {
    if (!socketRef.current || !message.trim()) return;

    const messageData = {
      username: 'Admin',
      message: message.trim(),
      timestamp: new Date().toISOString(),
      id: Math.random().toString(36).substr(2, 9)
    };

    socketRef.current.emit('chat:message', messageData);
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="bg-gray-800 p-8 rounded-lg shadow-lg w-96">
          <h2 className="text-2xl text-white mb-6 text-center">Admin Login</h2>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="text-white block mb-2">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full p-2 rounded bg-gray-700 text-white"
                required
              />
            </div>
            <div>
              <label className="text-white block mb-2">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full p-2 rounded bg-gray-700 text-white"
                required
              />
            </div>
            {streamError && (
              <div className="text-red-500 text-sm">{streamError}</div>
            )}
            <button
              type="submit"
              className="w-full bg-blue-600 text-white p-2 rounded hover:bg-blue-700"
            >
              Login
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row gap-4 p-4 bg-gray-900 min-h-screen">
      <div className="lg:w-2/3">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-[calc(100vh-2rem)] object-contain rounded-lg bg-gray-800"
        />
        <div className="flex gap-4 mt-4">
          <button
            onClick={toggleVideo}
            className={`px-4 py-2 rounded ${
              isVideoEnabled ? 'bg-red-500' : 'bg-green-500'
            } text-white`}
          >
            {isVideoEnabled ? 'Stop Video' : 'Start Video'}
          </button>
          <button
            onClick={toggleAudio}
            className={`px-4 py-2 rounded ${
              isAudioEnabled ? 'bg-red-500' : 'bg-green-500'
            } text-white`}
          >
            {isAudioEnabled ? 'Mute Audio' : 'Unmute Audio'}
          </button>
        </div>
        
        <div className="mt-4 bg-gray-800 p-4 rounded-lg">
          <h3 className="text-white text-lg mb-2">Viewers: {viewerStats.count}</h3>
          <div className="grid grid-cols-2 gap-2">
            {viewerStats.viewers.slice(0, 50).map((viewer, index) => (
              <div key={index} className="text-gray-300 text-sm">
                {viewer.username} ({viewer.country})
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="lg:w-1/3">
        <Chat
          messages={messages}
          onSendMessage={handleSendMessage}
        />
      </div>
    </div>
  );
};

export default AdminStreamer;
