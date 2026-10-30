import { Routes, Route } from "react-router-dom";
import Home from "./Home";
import Phone from "./Phone";

function App() {
    return (
        <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/join/:sessionId" element={<Phone />} />
        </Routes>
    );
}

export default App;